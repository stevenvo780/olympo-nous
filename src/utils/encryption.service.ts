import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "crypto";

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = "aes-256-gcm";
  private readonly keyLength = 32;
  private readonly ivLength = 16;
  private readonly tagLength = 16;
  private readonly encryptionKey: Buffer;

  constructor() {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      throw new Error("ENCRYPTION_KEY environment variable is required");
    }
    // Salt for key derivation. Prefer a per-deployment salt from env so the same
    // ENCRYPTION_KEY does NOT derive the same key across environments (which
    // defeats the salt and helps precomputation if a ciphertext leaks). The
    // legacy literal `"nous-salt"` is kept ONLY as the default to remain able to
    // decrypt data written before this change; setting ENCRYPTION_SALT rotates
    // it for new deployments. In production a real salt is strongly recommended.
    const salt = process.env.ENCRYPTION_SALT || "nous-salt";
    if (salt === "nous-salt" && process.env.NODE_ENV === "production") {
      this.logger.warn(
        "⚠️ ENCRYPTION_SALT no configurado en producción: se usa el salt legacy estático. " +
          "Configura ENCRYPTION_SALT (por entorno) para fortalecer la derivación de clave.",
      );
    }
    this.encryptionKey = crypto.scryptSync(key, salt, this.keyLength);
  }

  /**
   * Encrypt sensitive credential data
   */
  encryptCredentials(data: Record<string, any>): string {
    try {
      const sensitiveFields = [
        "apiKey",
        "password",
        "secret",
        "token",
        "webhookSecret",
      ];
      const encryptedData = { ...data };

      for (const field of sensitiveFields) {
        if (encryptedData[field] && typeof encryptedData[field] === "string") {
          encryptedData[field] = this.encryptField(encryptedData[field]);
        }
      }

      return JSON.stringify(encryptedData);
    } catch (error) {
      this.logger.error(`Error encrypting credentials: ${error.message}`);
      throw new Error("Credential encryption failed");
    }
  }

  /**
   * Decrypt sensitive credential data
   */
  decryptCredentials(encryptedData: string): Record<string, any> {
    try {
      const data = JSON.parse(encryptedData);
      const sensitiveFields = [
        "apiKey",
        "password",
        "secret",
        "token",
        "webhookSecret",
      ];
      const decryptedData = { ...data };

      for (const field of sensitiveFields) {
        if (decryptedData[field] && typeof decryptedData[field] === "string") {
          try {
            decryptedData[field] = this.decryptField(decryptedData[field]);
          } catch {
            this.logger.debug(`Field ${field} appears to be unencrypted`);
          }
        }
      }

      return decryptedData;
    } catch (error) {
      this.logger.error(`Error decrypting credentials: ${error.message}`);
      throw new Error("Credential decryption failed");
    }
  }

  /**
   * Encrypt individual field using AES-256-GCM
   */
  private encryptField(text: string): string {
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(
      this.algorithm,
      this.encryptionKey,
      iv,
    );

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  }

  /**
   * Decrypt individual field using AES-256-GCM
   */
  private decryptField(encryptedText: string): string {
    const parts = encryptedText.split(":");
    if (parts.length < 3) {
      return this.decryptLegacyField(encryptedText);
    }

    const [ivHex, authTagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.encryptionKey,
      iv,
    );
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  /**
   * Decrypt legacy format for backward compatibility.
   *
   * The legacy format was written with the now-REMOVED `crypto.createDecipher`
   * (deprecated, MD5-based KDF, no IV). That API no longer exists on Node 18+
   * (removed in Node 22), so it cannot be re-derived securely or even reliably
   * called at runtime. We do NOT invoke a removed/insecure primitive: instead we
   * fail closed with a clear, actionable error. Any remaining legacy values must
   * be re-encrypted out-of-band (one-off migration with the original key on a
   * compatible runtime), after which this method can be deleted entirely.
   */
  private decryptLegacyField(_encryptedText: string): string {
    this.logger.error(
      "Legacy-encrypted credential found but the legacy crypto path is removed " +
        "(crypto.createDecipher is insecure and no longer available). Re-encrypt " +
        "this record with AES-256-GCM via a one-off migration.",
    );
    throw new Error(
      "Legacy encryption format is no longer supported; re-encrypt the credential",
    );
  }

  /**
   * Check if data appears to be encrypted
   */
  isEncrypted(data: string): boolean {
    try {
      const parsed = JSON.parse(data);
      const sensitiveFields = [
        "apiKey",
        "password",
        "secret",
        "token",
        "webhookSecret",
      ];

      for (const field of sensitiveFields) {
        if (parsed[field] && typeof parsed[field] === "string") {
          const parts = parsed[field].split(":");
          if (
            parts.length >= 2 &&
            parts.every((part) => /^[0-9a-f]+$/i.test(part))
          ) {
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}
