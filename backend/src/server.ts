import Fastify from 'fastify';
import cors from '@fastify/cors';
import budgetRoutes from './routes/budget';
import registerRoutes from './routes/register';
import reportRoutes from './routes/reports';

const app = Fastify({ logger: false });

await app.register(cors, { origin: true });
app.get('/api/health', async () => ({ ok: true }));
await app.register(budgetRoutes, { prefix: '/api' });
await app.register(registerRoutes, { prefix: '/api' });
await app.register(reportRoutes, { prefix: '/api' });

const port = Number(process.env.PORT ?? 3001);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`YNAB-clone API → http://localhost:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
