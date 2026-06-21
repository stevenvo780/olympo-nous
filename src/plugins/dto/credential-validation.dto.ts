import {
  IsString,
  IsOptional,
  IsUrl,
  IsObject,
  IsNotEmpty,
  Length,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class LogosCredentialsDto {
  @ApiProperty({ description: "API Key para SIGO" })
  @IsString()
  @IsNotEmpty()
  @Length(10, 100)
  apiKey: string;

  @ApiPropertyOptional({ description: "URL base del servicio SIGO" })
  @IsOptional()
  @IsUrl()
  baseUrl?: string;

  @ApiPropertyOptional({ description: "Timeout en milisegundos" })
  @IsOptional()
  timeout?: number;
}

export class IrisCredentialsDto {
  @ApiProperty({ description: "API Key para IRIS" })
  @IsString()
  @IsNotEmpty()
  @Length(10, 100)
  apiKey: string;

  @ApiPropertyOptional({ description: "Secret para webhooks IRIS" })
  @IsOptional()
  @IsString()
  webhookSecret?: string;

  @ApiPropertyOptional({ description: "URL base del servicio IRIS" })
  @IsOptional()
  @IsUrl()
  baseUrl?: string;
}

export class TalariaCredentialsDto {
  @ApiProperty({ description: "API Key para Talaria" })
  @IsString()
  @IsNotEmpty()
  @Length(10, 100)
  apiKey: string;

  @ApiPropertyOptional({ description: "Usuario para autenticación" })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ description: "URL base del servicio Talaria" })
  @IsOptional()
  @IsUrl()
  baseUrl?: string;
}

export class HermesCredentialsDto {
  @ApiProperty({ description: "API Key para Hermes" })
  @IsString()
  @IsNotEmpty()
  @Length(10, 100)
  apiKey: string;

  @ApiProperty({ description: "Store ID" })
  @IsString()
  @IsNotEmpty()
  storeId: string;

  @ApiPropertyOptional({ description: "Secret para webhooks Hermes" })
  @IsOptional()
  @IsString()
  webhookSecret?: string;

  @ApiPropertyOptional({ description: "URL base del servicio Hermes" })
  @IsOptional()
  @IsUrl()
  baseUrl?: string;
}

export class TalantonCredentialsDto {
  @ApiProperty({ description: "API Key para Talanton POS" })
  @IsString()
  @IsNotEmpty()
  @Length(10, 100)
  apiKey: string;

  @ApiProperty({ description: "Terminal ID" })
  @IsString()
  @IsNotEmpty()
  terminalId: string;

  @ApiPropertyOptional({ description: "URL base del servicio Talanton" })
  @IsOptional()
  @IsUrl()
  baseUrl?: string;
}

export class PistisCredentialsDto {
  @ApiProperty({ description: "API Key para PISTIS" })
  @IsString()
  @IsNotEmpty()
  @Length(10, 100)
  apiKey: string;

  @ApiProperty({ description: "Merchant ID" })
  @IsString()
  @IsNotEmpty()
  merchantId: string;

  @ApiPropertyOptional({ description: "URL base del servicio PISTIS" })
  @IsOptional()
  @IsUrl()
  baseUrl?: string;
}

export class ValidatedUpdatePluginDto {
  @ApiPropertyOptional({ description: "Habilitar/deshabilitar plugin" })
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: "Configuración específica según el tipo de plugin",
    oneOf: [
      { $ref: "#/components/schemas/LogosCredentialsDto" },
      { $ref: "#/components/schemas/IrisCredentialsDto" },
      { $ref: "#/components/schemas/TalariaCredentialsDto" },
      { $ref: "#/components/schemas/HermesCredentialsDto" },
      { $ref: "#/components/schemas/TalantonCredentialsDto" },
      { $ref: "#/components/schemas/PistisCredentialsDto" },
    ],
  })
  @IsOptional()
  @IsObject()
  config?:
    | LogosCredentialsDto
    | IrisCredentialsDto
    | TalariaCredentialsDto
    | HermesCredentialsDto
    | TalantonCredentialsDto
    | PistisCredentialsDto
    | Record<string, any>;
}

export const PLUGIN_VALIDATION_MAP = {
  logos: LogosCredentialsDto,
  iris: IrisCredentialsDto,
  talaria: TalariaCredentialsDto,
  hermes: HermesCredentialsDto,
  talanton: TalantonCredentialsDto,
  pistis: PistisCredentialsDto,
};

export class SecurityValidation {
  static validateSensitiveField(value: string, fieldName: string): boolean {
    const patterns = {
      apiKey: /^[A-Za-z0-9_\-+=\/:]{10,100}$/,
      password: /^.{8,}$/,
      secret: /^[A-Za-z0-9_\-+=\/:]{16,}$/,
      token: /^[A-Za-z0-9_.\-+=\/:]{20,}$/,
    };

    const pattern = patterns[fieldName] || patterns.secret;
    return pattern.test(value);
  }

  static sanitizeConfig(config: Record<string, any>): Record<string, any> {
    const sanitized = { ...config };

    const dangerousFields = ["__proto__", "constructor", "prototype"];
    dangerousFields.forEach((field) => delete sanitized[field]);

    const sensitiveFields = [
      "apiKey",
      "password",
      "secret",
      "token",
      "webhookSecret",
    ];
    sensitiveFields.forEach((field) => {
      if (
        sanitized[field] &&
        !this.validateSensitiveField(sanitized[field], field)
      ) {
        throw new Error(`Invalid format for field: ${field}`);
      }
    });

    return sanitized;
  }
}
