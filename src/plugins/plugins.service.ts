import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { PluginSetting } from "./entities/plugin-setting.entity";
import { UpdatePluginDto } from "./dto/update-plugin.dto";
import { EncryptionService } from "../utils/encryption.service";
import { SecurityValidation } from "./dto/credential-validation.dto";
import { UserEntity } from "../users/entities/user.entity";

@Injectable()
export class PluginsService {
  private readonly logger = new Logger(PluginsService.name);

  constructor(
    @InjectRepository(PluginSetting)
    private readonly repo: Repository<PluginSetting>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly httpService: HttpService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async listUserPlugins(
    userId: string,
    service?: string,
  ): Promise<PluginSetting[]> {
    const where: any = { user: { id: userId } };
    if (service) where.service = service;
    const plugins = await this.repo.find({
      where,
      order: { pluginKey: "ASC" },
    });

    return plugins.map((plugin) => {
      if (plugin.config) {
        try {
          if (typeof plugin.config === "string") {
            plugin.config = this.encryptionService.decryptCredentials(
              plugin.config,
            );
          } else if (typeof plugin.config === "object") {
            plugin.config = this.decryptConfigFields(plugin.config);
          }
        } catch (error) {
          this.logger.debug(
            `Could not decrypt config for plugin ${plugin.pluginKey}, assuming unencrypted: ${error.message}`,
          );
        }
      }
      return plugin;
    });
  }

  async upsertUserPlugin(
    userId: string,
    service: string,
    pluginKey: string,
    input: UpdatePluginDto,
    auditMetadata?: { ip?: string; userAgent?: string },
    subconfigId?: string,
  ): Promise<PluginSetting> {
    let isNewPlugin = false;

    try {
      let sanitizedConfig = input.config;
      if (input.config) {
        sanitizedConfig = SecurityValidation.sanitizeConfig(input.config);
      }

      let row = await this.repo.findOne({
        where: { user: { id: userId }, service, pluginKey },
      });

      isNewPlugin = !row;
      const action = isNewPlugin ? "CREATE" : "UPDATE";

      if (!row) {
        row = this.repo.create({
          user: { id: userId },
          service,
          pluginKey,
          enabled: false,
          config: {},
        });
      }

      if (subconfigId) {
        const currentConfig = row.config || {};
        const subconfigKey = subconfigId || "default";

        if (typeof input.enabled === "boolean") {
          row.enabled = input.enabled;
        }

        if (sanitizedConfig) {
          currentConfig[subconfigKey] = sanitizedConfig;
          row.config = currentConfig;
        }
      } else {
        if (typeof input.enabled === "boolean") row.enabled = input.enabled;
        if (sanitizedConfig) {
          const currentConfig = row.config || {};
          const updatedConfig = { ...currentConfig, ...sanitizedConfig };
          const encryptedData =
            this.encryptionService.encryptCredentials(updatedConfig);
          row.config =
            typeof encryptedData === "string"
              ? JSON.parse(encryptedData)
              : encryptedData;
        }
      }

      const result = await this.repo.save(row);

      this.logger.log(
        `Plugin ${pluginKey} ${action.toLowerCase()}d successfully for user ${userId}`,
      );
      const resultCfg = result?.config || {};
      const effective = subconfigId ? (resultCfg as any) : (resultCfg as any);
      const trigger = (subconfigId
        ? (resultCfg?.[subconfigId as string] || {})
        : resultCfg)?.triggerEvent;
      this.logger.log(
        `Upsert summary: service=${service} plugin=${pluginKey} sub=${subconfigId} triggerEvent=${trigger ?? '<none>'}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Error upserting plugin ${pluginKey} for user ${userId}:`,
        error.message,
      );

      throw error;
    }
  }

  async getUserPlugin(
    userId: string,
    service: string,
    pluginKey: string,
    auditMetadata?: { ip?: string },
    subconfigId?: string,
  ): Promise<PluginSetting | null> {
    try {
      const localPlugin = await this.repo.findOne({
        where: { user: { id: userId }, service, pluginKey },
      });

      if (localPlugin) {
        if (localPlugin.config) {
          try {
            if (typeof localPlugin.config === "string") {
              localPlugin.config = this.encryptionService.decryptCredentials(
                localPlugin.config,
              );
            } else if (typeof localPlugin.config === "object") {
              localPlugin.config = this.decryptConfigFields(localPlugin.config);
            }
          } catch (error) {
            this.logger.debug(
              `Could not decrypt config for plugin ${pluginKey}, assuming unencrypted: ${error.message}`,
            );
          }
        }

        if (subconfigId && typeof localPlugin.config === "object") {
          const subconfigKey = subconfigId || "default";
          if (localPlugin.config[subconfigKey]) {
            const result = { ...localPlugin };
            result.config = localPlugin.config[subconfigKey];
            return result;
          }
          return null;
        }

        return localPlugin;
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Error retrieving plugin ${pluginKey} for user ${userId}:`,
        error.message,
      );

      throw error;
    }

    return null;
  }

  async deleteUserPlugin(
    userId: string,
    service: string,
    pluginKey: string,
    auditMetadata?: { ip?: string; userAgent?: string },
    subconfigId?: string,
  ): Promise<boolean> {
    try {
      if (subconfigId) {
        const plugin = await this.repo.findOne({
          where: { user: { id: userId }, service, pluginKey },
        });

        if (plugin && typeof plugin.config === "object") {
          const subconfigKey = subconfigId || "default";
          if (plugin.config[subconfigKey]) {
            delete plugin.config[subconfigKey];

            if (Object.keys(plugin.config).length === 0) {
              await this.repo.remove(plugin);
            } else {
              await this.repo.save(plugin);
            }

            return true;
          }
        }
        return false;
      } else {
        const result = await this.repo.delete({
          user: { id: userId },
          service,
          pluginKey,
        });

        const deleted = result.affected && result.affected > 0;

        if (deleted) {
          this.logger.log(
            `Plugin ${pluginKey} deleted successfully for user ${userId}`,
          );
        }

        return deleted;
      }
    } catch (error) {
      this.logger.error(
        `Error deleting plugin ${pluginKey} for user ${userId}:`,
        error.message,
      );

      throw error;
    }
  }

  async getUserWebhookSecret(
    userId: string | undefined,
    pluginKey: string,
    service = "nous",
  ): Promise<string | undefined> {
    if (!userId) return undefined;
    const row = await this.getUserPlugin(userId, service, pluginKey);
    const cfg = row?.config || {};
    return (cfg.webhookSecret || cfg.secret || cfg.apiSecret) as
      | string
      | undefined;
  }

  /**
   * Create or update user
   */
  async createOrUpdateUser(userData: { email: string }): Promise<UserEntity> {
    try {
      let user = await this.userRepo.findOne({
        where: { email: userData.email },
      });

      if (!user) {
        user = this.userRepo.create({
          email: userData.email,
        });
        this.logger.log(`🆕 Creating new user: ${userData.email}`);
      } else {
        this.logger.log(`🔄 User already exists: ${userData.email}`);
      }

      return this.userRepo.save(user);
    } catch (error) {
      this.logger.error(`Error creating/updating user: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get user credentials from plugins for backward compatibility
   */
  async getUserCredentials(userId: string): Promise<{
    userId: string;
    email: string;
    credentials: Record<string, any>;
  }> {
    const user = await this.userRepo.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`User not found: ${userId}`);
    }

    const plugins = await this.listUserPlugins(userId);
    const credentials: Record<string, any> = {};

    plugins.forEach((plugin) => {
      credentials[plugin.pluginKey] = plugin.config || {};
    });

    return {
      userId: user.id,
      email: user.email,
      credentials,
    };
  }

  /**
   * Get all users (without sensitive data)
   */
  async getAllUsers(): Promise<UserEntity[]> {
    return this.userRepo.find({
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Find user by ID
   */
  async findUserById(userId: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({ where: { id: userId } });
  }

  /**
   * Find user by email
   */
  async findUserByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({ where: { email } });
  }

  /**
   * Decrypt sensitive fields in config object
   */
  private decryptConfigFields(config: any): any {
    if (!config || typeof config !== "object") {
      return config;
    }

    const decryptedConfig = { ...config };
    const sensitiveFields = [
      "apiKey",
      "password",
      "secret",
      "token",
      "webhookSecret",
    ];

    for (const [key, value] of Object.entries(decryptedConfig)) {
      if (typeof value === "object" && value !== null) {
        decryptedConfig[key] = this.decryptConfigFields(value);
      } else if (typeof value === "string" && sensitiveFields.includes(key)) {
        try {
          const parts = value.split(":");
          if (parts.length === 3) {
            decryptedConfig[key] = this.encryptionService.decryptCredentials(
              JSON.stringify({ [key]: value }),
            )[key];
          }
        } catch (error) {
          this.logger.debug(`Could not decrypt field ${key}: ${error.message}`);
        }
      }
    }

    return decryptedConfig;
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const userCount = await this.userRepo.count();
      const pluginCount = await this.repo.count();

      return {
        status: "healthy",
        userCount,
        pluginCount,
        encryptionEnabled: !!process.env.ENCRYPTION_KEY,
        auditEnabled: true,
      };
    } catch (error) {
      return {
        status: "unhealthy",
        error: error.message,
      };
    }
  }
}
