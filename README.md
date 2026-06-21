# 🚀 Hub Central - ERP Prizma

Hub Central orquesta eventos y flujos de negocio del ecosistema Prizma.

## 🌟 Descripción

Conecta servicios del ecosistema:
- Hermes (e‑commerce), IRIS (WhatsApp), Talaria (delivery), PISTIS (crédito), Talanton (POS), Logos (facturación)

## ✨ Características

- Eventos pub/sub con Redis y colas por prioridad
- Webhooks con validación HMAC y contexto multi‑tenant
- Conectores que implementan flujos de negocio (billing, delivery, messaging)
- Reintentos, métricas, health checks y Swagger

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                         HUB CENTRAL                         │
├─────────────────────────────────────────────────────────────┤
│  Webhooks  │  Events Service  │  Connectors  │  Queue(Redis)│
└─────────────────────────────────────────────────────────────┘
          Hermes / IRIS / Talaria / PISTIS / Talanton / Logos
```

## 🚀 Arranque Rápido

### Prerrequisitos
- Node.js >= 18
- Redis >= 6.0
- Base de datos: PostgreSQL >= 14 (por defecto en código)

Nota: Existe un `docker-compose.yml` legado con MySQL. El código actual usa TypeORM configurado para PostgreSQL; ajusta variables `DB_*` según tu motor.

### Configuración

1) Variables de entorno
```bash
cd Nous
cp .env.example .env
# Editar .env (PORT, DB_*, REDIS_*, API keys)
```

2) Dependencias
```bash
npm install
```

3) Desarrollo
```bash
npm run start:dev
```

4) Producción
```bash
npm run build
npm run start:prod
```

5) Docker
- Ecosistema completo (desde la raíz del monorepo):
```bash
docker compose -f docker-compose.ecosystem.yml up -d
```
- Solo Nous (archivo local):
```bash
docker compose -f Nous/docker-compose.yml up -d
```

## 📡 API

Base URL: `http://localhost:3007/api/v1`

### Eventos
- `POST /events` → Emitir evento genérico
- `POST /events/ecosystem` → Emitir evento tipado
- `GET /events/type/:type` → Listar por tipo
- `GET /events/source/:source` → Listar por fuente
- `GET /events/transaction/:transactionId` → Buscar por transactionId
- `GET /events/metrics` → Métricas
- `POST /events/cleanup` → Limpiar antiguos

### Webhooks
- `POST /webhooks/hermes` → Endpoint universal para eventos de Hermes
  - Headers: `x-tenant-id`, `x-hermes-signature` (HMAC‑SHA256)
- `POST /webhooks/pedido-pagado` → Específico para pedido pagado
- `POST /webhooks/delivery-confirmation` (Talaria)
- `POST /webhooks/delivery-status-update` (Talaria)
- `POST /webhooks/notification-confirmation` (IRIS)
- `POST /webhooks/notification-status-update` (IRIS)

### Health y Plugins
- `GET /health` → Estado general
- `GET /health/database` | `GET /health/redis`
- `GET /health/ecosystem` | `GET /health/metrics`
- `GET /plugins/plugins` → Catálogo global
- `GET /plugins/tenants/:tenantId/plugins` → Plugins por tenant
- `PUT /plugins/tenants/:tenantId/plugins/:pluginKey/credentials` → Credenciales
- `GET /plugins/tenants/:tenantId/plugins/:pluginKey/health` → Estado plugin

Swagger: `http://localhost:3007/api/docs`

## 🔄 Flujos Soportados (ejemplos)

- Venta e‑commerce pagada (Hermes → Logos → Talaria → IRIS)
- Venta e‑commerce pendiente: notifica POS y continúa al pagar
- Venta en tienda: Talanton → delivery/mensajería/facturación
- Sincronización de inventario Hermes ↔ Talanton

## 🔧 Variables de Entorno (ejemplo)

```bash
NODE_ENV=development
PORT=3007

# PostgreSQL (por defecto en código)
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=prizma
DB_PASSWORD=prizma
DB_NAME=nous

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# APIs del ecosistema
HERMES_API_URL=http://localhost:3000
IRIS_API_URL=http://localhost:3001
TALARIA_API_URL=http://localhost:3006
LOGOS_API_URL=http://localhost:3004

# Firma opcional hacia Logos (recomendado dejar vacío si no la usas)
# Si se define, Nous enviará el header x-hub-signature con este valor.
# Debe coincidir con HUB_WEBHOOK_SECRET en Logos; si no coincide, Logos rechazará la petición.
LOGOS_HUB_WEBHOOK_SECRET=
```

## 📊 Monitoreo Rápido

```bash
curl http://localhost:3007/api/v1/health
curl http://localhost:3007/api/v1/health/ecosystem
curl http://localhost:3007/api/v1/events/metrics
```

## 🧪 Testing y Lint

```bash
npm test            # unit
npm run test:e2e    # e2e
npm run test:cov    # coverage
npm run lint        # eslint --fix
```

## 📝 Logs

Los logs se almacenan en:
- Consola (desarrollo)
- Archivos en `/logs` (producción)
- Métricas en base de datos

## 🔐 Seguridad

- Validación de firmas webhook
- Autenticación por API key
- Rate limiting
- Validación de entrada

## 🚀 Deployment

### Docker
```bash
docker build -t nous .
docker run -p 3007:3007 nous
```

### Production
- Configurar variables de entorno
- Configurar proxy reverso (nginx)
- Configurar monitoreo (Prometheus/Grafana)
- Configurar logs centralizados

---

**Parte del Ecosistema Prizma** 🌟
