import { Injectable, Logger } from "@nestjs/common";
import { AxiosRequestConfig, AxiosResponse, AxiosError } from "axios";

@Injectable()
export class HttpLoggingInterceptor {
  private readonly logger = new Logger("HTTP");

  setupInterceptors(axiosInstance: any) {
    axiosInstance.interceptors.request.use(
      (config: AxiosRequestConfig) => {
        this.logRequest(config);
        return config;
      },
      (error: AxiosError) => {
        this.logger.error("❌ Request setup error:", error.message);
        return Promise.reject(error);
      },
    );

    axiosInstance.interceptors.response.use(
      (response: AxiosResponse) => {
        this.logResponse(response);
        return response;
      },
      (error: AxiosError) => {
        this.logError(error);
        return Promise.reject(error);
      },
    );
  }

  private logRequest(config: AxiosRequestConfig) {
    const { method, url, headers = {} } = config;

    const service = this.extractServiceFromUrl(url);

    this.logger.log(`🚀 ${service} ${method?.toUpperCase()} ${url}`);

    const authHeaders = this.extractAuthHeaders(headers);
    if (Object.keys(authHeaders).length > 0) {
      this.logger.debug(`🔐 ${service} Auth: ${JSON.stringify(authHeaders)}`);
    }
  }

  private logResponse(response: AxiosResponse) {
    const { status, statusText, config } = response;
    const service = this.extractServiceFromUrl(config.url);

    this.logger.log(`✅ ${service} ${status} ${statusText}`);
  }

  private logError(error: AxiosError) {
    const service = this.extractServiceFromUrl(error.config?.url);

    if (error.response) {
      const { status, statusText, data } = error.response;
      this.logger.error(`❌ ${service} ${status} ${statusText}`);

      const responseData =
        typeof data === "string" ? data : JSON.stringify(data);
      const truncatedData =
        responseData.length > 150
          ? responseData.substring(0, 150) + "..."
          : responseData;
      this.logger.error(`❌ ${service} Response: ${truncatedData}`);

      if (status === 401 || status === 403) {
        const authHeaders = this.extractAuthHeaders(
          error.config?.headers || {},
        );
        if (Object.keys(authHeaders).length > 0) {
          this.logger.error(
            `❌ ${service} Sent headers: ${JSON.stringify(authHeaders)}`,
          );
        }
      }
    } else if (error.request) {
      this.logger.error(`❌ ${service} No response (timeout/connection)`);
      if (error.code) {
        this.logger.error(`❌ ${service} Error code: ${error.code}`);
      }
    } else {
      this.logger.error(`❌ ${service} Request setup: ${error.message}`);
    }
  }

  private extractServiceFromUrl(url?: string): string {
    if (!url) return "[Unknown]";

    try {
      const urlObj = new URL(url);
      const port = urlObj.port;

      const serviceMap = {
        "3004": "[Logos]",

        "3006": "[Talaria]",
        "3001": "[IRIS]",
        "8090": "[PISTIS]",
        "4001": "[Talanton]",
        "3009": "[Hermes]",
      };

      return serviceMap[port] || `[${urlObj.hostname}:${port}]`;
    } catch {
      return "[HTTP]";
    }
  }

  private extractAuthHeaders(headers: any): Record<string, string> {
    const authHeaders: Record<string, string> = {};

    Object.keys(headers).forEach((key) => {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("signature") ||
        lowerKey.includes("authorization") ||
        lowerKey.includes("auth") ||
        lowerKey.includes("key") ||
        lowerKey.includes("tenant")
      ) {
        const value = headers[key];
        authHeaders[key] =
          typeof value === "string" && value.length > 20
            ? value.substring(0, 15) + "..."
            : value;
      }
    });

    return authHeaders;
  }
}
