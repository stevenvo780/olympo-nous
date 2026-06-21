import {
  Injectable,
  NestMiddleware,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { Request as ExpressRequest, Response, NextFunction } from "express";
import { PluginsService } from "../plugins/plugins.service";

export interface ResolvedUserContext {
  userId: string;
  userEmail: string;
  userCredentials?: any;
}

declare module "express-serve-static-core" {
  interface Request {
    userContext?: ResolvedUserContext;
  }
}

@Injectable()
export class UserResolverMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UserResolverMiddleware.name);

  /**
   * Shared internal secret that trusted server-to-server callers (Hermes/portal
   * backends) MUST present to act on behalf of a user via `x-user-email`. The
   * `x-user-email` header alone is NOT authentication — anyone could spoof it —
   * so we require this secret before trusting it. Reuses the hub secret env vars.
   */
  private readonly internalSecret =
    process.env.NOUS_INTERNAL_SECRET ||
    process.env.PRIZMA_NOUS_SECRET ||
    process.env.PRIZMA_HUB_SECRET ||
    process.env.HUB_CENTRAL_SECRET ||
    process.env.NOUS_SECRET ||
    process.env.NOUS_HUB_SECRET ||
    process.env.CAUCE_HUB_SECRET ||
    undefined;

  constructor(private pluginsService: PluginsService) {}

  async use(req: ExpressRequest, res: Response, next: NextFunction) {
    try {
      if (this.isSystemWebhook(req)) {
        next();
        return;
      }

      const isApiKeyAuth = req.headers["x-api-key"] && req.headers["x-source"];

      if (isApiKeyAuth) {
        this.logger.debug(
          "🔑 Usando autenticación por API Key - omitiendo resolución de usuario",
        );
        next();
        return;
      }

      // FAIL-CLOSED: x-user-email is impersonatable; require the internal secret
      // before resolving/trusting the user identity for /plugins/* routes.
      if (!this.hasValidInternalSecret(req)) {
        if (process.env.NODE_ENV === "production" || this.internalSecret) {
          this.logger.warn(
            "🔒 Petición a ruta protegida sin secreto interno válido — 401.",
          );
          res
            .status(401)
            .json({ message: "Unauthorized: missing/invalid internal secret" });
          return;
        }
        // Dev only (no secret configured): allow but warn loudly.
        this.logger.warn(
          "⚠️ NOUS_INTERNAL_SECRET no configurado (dev): se confía en x-user-email SIN verificación. NO usar en producción.",
        );
      }

      const userContext = await this.resolveUserFromRequest(req);
      if (userContext) {
        req.userContext = userContext;
        this.logger.debug(
          `🔍 Usuario resuelto: ${userContext.userEmail} (${userContext.userId})`,
        );
      }
    } catch (error) {
      this.logger.warn(`Error resolviendo usuario: ${error.message}`);
      if (error instanceof UnauthorizedException) {
        res.status(401).json({ message: "Unauthorized: Invalid API Key" });
        return;
      }
    }

    next();
  }

  /** Constant-time check of the internal secret header (Bearer or x-internal-secret). */
  private hasValidInternalSecret(req: ExpressRequest): boolean {
    if (!this.internalSecret) return false;
    const headers = req.headers || {};
    const bearer = (headers["authorization"] as string) || "";
    const provided =
      (headers["x-internal-secret"] as string) ||
      (bearer.toLowerCase().startsWith("bearer ")
        ? bearer.slice(7).trim()
        : "");
    if (!provided) return false;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(this.internalSecret, "utf8");
    if (a.length !== b.length) {
      crypto.timingSafeEqual(a, a);
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  private isSystemWebhook(req: ExpressRequest): boolean {
    // When this middleware is mounted via `forRoutes("webhooks/*")`, Express
    // rewrites `req.path`/`req.url` to be RELATIVE to the mount point (e.g. "/"),
    // so they no longer end with "/webhooks/nous". The full request path is only
    // available on `originalUrl` (and `baseUrl`). Check all of them so the system
    // webhook bypass actually matches; otherwise every canonical event hits the
    // internal-secret gate and is 401'd before HMAC verification.
    const candidates = [
      req.path,
      req.url,
      (req as any).originalUrl,
      (req as any).baseUrl,
    ].filter(Boolean) as string[];
    const matchesSystemPath = (p: string): boolean => {
      const clean = p.split("?")[0];
      return (
        clean.endsWith("/webhooks/nous") ||
        clean.endsWith("/webhooks/mercadopago") ||
        clean.endsWith("/webhooks/health")
      );
    };
    return candidates.some(matchesSystemPath);
  }

  private async resolveUserFromRequest(
    req: ExpressRequest,
  ): Promise<ResolvedUserContext | null> {
    const headers = req.headers || {};
    const email = headers["x-user-email"] as string;

    if (!email) {
      this.logger.warn("🚫 Header x-user-email es requerido");
      return null;
    }

    let user = await this.pluginsService.findUserByEmail(email);
    if (!user) {
      // Only auto-provision on a WRITE (PUT/POST/PATCH), where creating the
      // user is part of upserting their credentials. NEVER on a GET/DELETE —
      // that would allow arbitrary user enumeration/creation via reads.
      const method = (req.method || "GET").toUpperCase();
      const isWrite =
        method === "PUT" || method === "POST" || method === "PATCH";
      if (!isWrite) {
        this.logger.warn(
          `🚫 Usuario no encontrado (${email}) en ${method}: no se auto-crea en lecturas.`,
        );
        return null;
      }
      this.logger.log(`🆕 Usuario no encontrado, creando nuevo usuario: ${email}`);
      user = await this.pluginsService.createOrUpdateUser({ email });
    }

    const credentials = await this.pluginsService.getUserCredentials(user.id);
    return {
      userId: user.id,
      userEmail: user.email,
      userCredentials: credentials,
    };
  }
}
