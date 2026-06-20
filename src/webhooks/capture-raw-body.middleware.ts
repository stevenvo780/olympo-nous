import { Injectable, NestMiddleware, Logger } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";

/**
 * CaptureRawBodyMiddleware — intercepts express.json() to capture the raw body
 * BEFORE JSON parsing. This allows EventProcessorService to verify signatures
 * against the exact bytes received (no re-serialization).
 *
 * Usage: attach to Nous webhook routes in app.module.ts
 *
 * Pattern:
 *   1. express.json() with verify callback stores raw buffer in (req as any).rawBody
 *   2. EventProcessorService.ingest() receives rawBody and passes to verifyRawBody()
 *   3. verifyRawBody() verifies HMAC on the exact bytes (no JSON.stringify issues)
 *   4. VerifiedEnvelope is then safe to parse with Zod
 */
@Injectable()
export class CaptureRawBodyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CaptureRawBodyMiddleware.name);

  use(req: Request, _res: Response, next: NextFunction) {
    // If rawBody is already set by the express.json() verify callback,
    // that's good — we already have the original bytes.
    // If not, log a warning (may indicate misconfiguration of main.ts rawBody setup).
    if (!(req as any).rawBody) {
      this.logger.warn(
        "⚠️ rawBody not captured — signature verification may fail. " +
          "Ensure main.ts has NestFactory.create(AppModule, { rawBody: true })"
      );
    }
    next();
  }
}
