import { Injectable } from "@nestjs/common";

@Injectable()
export class AppService {
  getInfo() {
    return {
      name: "Hub Central ERP Prizma",
      description: "Orquestador central de eventos para el ecosistema ERP",
      status: "active",
      timestamp: new Date().toISOString(),
      ecosystem: {
        systems: ["Hermes", "IRIS", "Talaria", "PISTIS", "Talanton", "Logos"],
        connectors: [
          "venta-a-factura-y-despacho",
          "stock-synchronization",
          "datos-a-marketing",
        ],
      },
    };
  }

  getVersion() {
    return {
      version: "1.0.0",
      build: process.env.BUILD_NUMBER || "dev",
      environment: process.env.NODE_ENV || "development",
      node_version: process.version,
    };
  }
}
