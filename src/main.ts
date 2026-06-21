import * as dotenv from "dotenv";
dotenv.config();

import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";


async function bootstrap() {
  // `rawBody: true` makes Nest capture the exact raw request buffer on
  // `req.rawBody`. Mercado Pago signs the raw body verbatim, so the MP webhook
  // (POST /webhooks/mercadopago) MUST verify against these original bytes — a
  // re-serialized JSON.stringify produces different bytes (key order/spacing)
  // and would fail every signature check.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.enableCors({
    origin: true,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.setGlobalPrefix("api/v1");

  const config = new DocumentBuilder()
    .setTitle("Hub Central API")
    .setDescription(
      "API del Hub Central de eventos para el ecosistema ERP Prizma",
    )
    .setVersion("1.0")
    .addTag("events", "Gestión de eventos del ecosistema")
    .addTag("webhooks", "Webhooks de entrada de sistemas externos")
    .addTag("health", "Health checks y monitoreo")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document);

  const port = process.env.PORT || 8080;
  await app.listen(port);

  console.info(`🚀 Hub Central ejecutándose en puerto ${port}`);
  console.info(
    `📚 Documentación disponible en http://localhost:${port}/api/docs`,
  );
}

bootstrap();
