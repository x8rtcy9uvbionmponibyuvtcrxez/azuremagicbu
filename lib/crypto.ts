import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // per NIST recommendation for GCM

type CipherPayload = {
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

export function ensureEncryptionKey(): void {
  void getEncryptionKey();
}

function getEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ENCRYPTION_KEY is not configured");
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes when base64 decoded");
  }

  return key;
}

function serialize({ iv, ciphertext, authTag }: CipherPayload): string {
  return [iv, ciphertext, authTag].map((part) => part.toString("base64")).join(":");
}

function deserialize(payload: string): CipherPayload {
  const segments = payload.split(":");
  if (segments.length !== 3) {
    throw new Error("Invalid ciphertext payload");
  }

  const [iv, ciphertext, authTag] = segments.map((segment) => Buffer.from(segment, "base64"));
  return { iv, ciphertext, authTag };
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) {
    return plaintext;
  }

  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return serialize({ iv, ciphertext, authTag });
}

export function decryptSecret(payload: string): string {
  if (!payload) {
    return payload;
  }

  const key = getEncryptionKey();
  const { iv, ciphertext, authTag } = deserialize(payload);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
