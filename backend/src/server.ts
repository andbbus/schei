import Fastify from 'fastify';
import cors from '@fastify/cors';
import budgetRoutes from './routes/budget';
import registerRoutes from './routes/register';
import expectedRoutes from './routes/expected';
import forecastRoutes from './routes/forecast';
import reportRoutes from './routes/reports';
import opsRoutes from './routes/ops';
import debtRoutes from './routes/debts';
import goalRoutes from './routes/goals';
import shoppingRoutes from './routes/shopping';
import importRoutes from './routes/imports';
import chatRoutes from './routes/chat';

const app = Fastify({ logger: false });

await app.register(cors, { origin: true });
app.get('/api/health', async () => ({ ok: true }));
await app.register(budgetRoutes, { prefix: '/api' });
await app.register(registerRoutes, { prefix: '/api' });
await app.register(expectedRoutes, { prefix: '/api' });
await app.register(forecastRoutes, { prefix: '/api' });
await app.register(reportRoutes, { prefix: '/api' });
await app.register(opsRoutes, { prefix: '/api' });
await app.register(debtRoutes, { prefix: '/api' });
await app.register(goalRoutes, { prefix: '/api' });
await app.register(shoppingRoutes, { prefix: '/api' });
await app.register(importRoutes, { prefix: '/api' });
await app.register(chatRoutes, { prefix: '/api' });

const port = Number(process.env.PORT ?? 3001);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`YNAB-clone API → http://localhost:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
