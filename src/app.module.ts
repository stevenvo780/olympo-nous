import { Module, NestModule, MiddlewareConsumer } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduleModule } from "@nestjs/schedule";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { ConnectorsModule } from "./connectors/connectors.module";
import { HealthModule } from "./health/health.module";
import { PluginsModule } from "./plugins/plugins.module";
import { QueueModule } from "./queue/queue.module";
import { MiddlewareModule } from "./middleware/middleware.module";
import { UserResolverMiddleware } from "./middleware/user-resolver.middleware";
import { PrizmaModule } from "./prizma/prizma.module";

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "5432"),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      autoLoadEntities: true,
      synchronize: process.env.NODE_ENV !== "production",
      logging: process.env.NODE_ENV !== "production",
      ssl:
        process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    }),

    ScheduleModule.forRoot(),
    PrizmaModule,
    WebhooksModule,
    ConnectorsModule,
    HealthModule,
    QueueModule,
    PluginsModule,
    MiddlewareModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(UserResolverMiddleware).forRoutes("webhooks/*", "plugins/*");
  }
}
