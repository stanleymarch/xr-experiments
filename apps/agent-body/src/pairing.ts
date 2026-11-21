/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { AgentSettings } from './agent/contracts.js';
import { agentSettingsSchema } from './agent/settings.js';

/**
 * Encrypted settings transfer from a desktop browser to a headset.
 *
 * Flow: the desktop app encrypts character and connection settings with AES-GCM under a key
 * derived (PBKDF2-SHA256) from a short PIN, and renders the result as
 * a QR code containing `<app-url>#pair=v2.<salt>.<iv>.<ciphertext>`. Any QR
 * scanner on the headset (or a copied link) opens that URL in the headset's
 * browser; the app then asks for the 6-digit PIN, decrypts, and writes the
 * settings into local IndexedDB. The API key never appears in clear text in
 * the QR, a URL query, or any server log: the payload lives in the fragment,
 * which browsers do not send to the server.
 *
 * This module is environment-agnostic (browser and Node) so the format can be
 * smoke-tested outside the app. Final validation happens in
 * `agentState.updateSettings`, which re-parses every patch with zod.
 */

const VERSION = 'v2';
const PBKDF2_ITERATIONS = 300_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PIN_DIGITS = 6;
const PIN_ALPHABET = '0123456789';
/** Pairing offers are intentionally short-lived. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface PairingOffer {
  /** Full URL including the `#pair=` fragment; encode this into the QR. */
  url: string;
  /** 6-digit PIN displayed next to the QR code (grouped "123 456"). */
  pin: string;
  /** Epoch ms after which the payload must be rejected. */
  expiresAt: number;
}

interface PairingPayload {
  settings: AgentSettings;
  exp: number;
}

type MinimalCrypto = {
  subtle: SubtleCrypto;
  getRandomValues(array: Uint8Array): Uint8Array;
};

function getCrypto(): MinimalCrypto {
  const value = globalThis.crypto;
  if (value?.subtle == null) {
    throw new Error('WebCrypto unavailable; pairing needs a secure context');
  }
  return value;
}

// --- Dependency-free base64 (works in browsers and Node alike) ---

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2]!;
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    out +=
      b1 == null
        ? '='
        : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    out += b2 == null ? '=' : BASE64_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

const BASE64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE64_ALPHABET.length; i++) {
  BASE64_LOOKUP[BASE64_ALPHABET[i]!] = i;
}

function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/=+$/u, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_LOOKUP[clean[i]!] ?? 0;
    const c1 = BASE64_LOOKUP[clean[i + 1]!] ?? 0;
    const c2 = BASE64_LOOKUP[clean[i + 2]!] ?? 0;
    const c3 = BASE64_LOOKUP[clean[i + 3]!] ?? 0;
    bytes[p++] = (c0 << 2) | (c1 >> 4);
    if (i + 2 < clean.length) {
      bytes[p++] = (c1 << 4) | (c2 >> 2);
    }
    if (i + 3 < clean.length) {
      bytes[p++] = (c2 << 6) | c3;
    }
  }
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array {
  return decodeBase64(value.replace(/-/gu, '+').replace(/_/gu, '/'));
}

function randomDigits(count: number): string {
  const bytes = getCrypto().getRandomValues(new Uint8Array(count));
  let pin = '';
  for (const byte of bytes) {
    pin += PIN_ALPHABET[byte % PIN_ALPHABET.length]!;
  }
  return pin;
}

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const crypto = getCrypto();
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Extracts the `pair` fragment payload from a URL or hash string. */
export function parsePairingFragment(
  source: string,
): { salt: string; iv: string; ciphertext: string } | null {
  const match =
    /#pair=([A-Za-z0-9]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/u
      .exec(source);
  if (match == null || match[1] !== VERSION) {
    return null;
  }
  return { salt: match[2]!, iv: match[3]!, ciphertext: match[4]! };
}

/** Builds a fresh encrypted offer for the current settings. */
export async function createPairingOffer(
  settings: AgentSettings,
  nowMs: number = Date.now(),
): Promise<PairingOffer> {
  const crypto = getCrypto();
  const pin = randomDigits(PIN_DIGITS);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const payload: PairingPayload = {
    settings: { ...settings },
    exp: nowMs + PAIRING_TTL_MS,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const key = await deriveKey(pin, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  const fragment = `#pair=${VERSION}.${toBase64Url(salt)}.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
  const base =
    typeof location === 'undefined'
      ? 'http://local.test/'
      : `${location.origin}${location.pathname}`;
  return {
    url: `${base}${fragment}`,
    pin: `${pin.slice(0, 3)} ${pin.slice(3)}`,
    expiresAt: payload.exp,
  };
}

/**
 * Decrypts and validates a pairing URL. Returns a settings patch on success.
 * Throws `Error` with a user-presentable message on wrong PIN, expiry, or a
 * malformed payload.
 */
export async function consumePairingUrl(
  url: string,
  pin: string,
  nowMs: number = Date.now(),
): Promise<Partial<AgentSettings>> {
  const parsed = parsePairingFragment(url);
  if (parsed == null) {
    throw new Error('This link is not a valid settings pairing link.');
  }
  const key = await deriveKey(
    pin.replace(/\D/gu, ''),
    fromBase64Url(parsed.salt),
  );
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await getCrypto().subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(parsed.iv) as BufferSource },
        key,
        fromBase64Url(parsed.ciphertext) as BufferSource,
      ),
    );
  } catch {
    throw new Error('Wrong PIN. Check the 6 digits shown next to the QR code.');
  }
  let payload: PairingPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(plaintext),
    ) as PairingPayload;
  } catch {
    throw new Error('Pairing payload is corrupted.');
  }
  if (typeof payload.exp !== 'number' || payload.exp < nowMs) {
    throw new Error('This pairing link has expired. Generate a new QR code.');
  }
  const parsedSettings = agentSettingsSchema.safeParse(payload.settings);
  if (!parsedSettings.success) {
    throw new Error('Pairing payload contains invalid settings.');
  }
  return parsedSettings.data;
}
