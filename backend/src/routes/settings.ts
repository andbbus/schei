import { readFileSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import { upsertEnv } from './setup';
import { sendDigestEmail } from '../digest';

// Email configuration UI backing (Options → Email): delivery channel
// (AgentMail or plain SMTP), recipient and weekly-digest toggle. Config is
// written to backend/.env via upsertEnv — the same pattern as the assistant
// setup — and applied to process.env live, so no restart is needed. Secrets
// are never returned: only last-4 tails.

const agentKey = (): string | null => {
  const env = process.env.AGENTMAIL_API_KEY?.trim();
  if (env) return env;
  const file = process.env.AGENTMAIL_API_KEY_FILE?.trim();
  if (file) {
    try {
      return readTrimmed(file);
    } catch {
      return null;
    }
  }
  return null;
};

function readTrimmed(path: string): string {
  return readFileSync(path, 'utf8').trim();
}

function tail(s: string | null | undefined): string | null {
  const v = s?.trim();
  return v ? v.slice(-4) : null;
}

function currentStatus() {
  const agent = !!agentKey();
  const smtp = !!process.env.SMTP_HOST?.trim();
  const provider = agent ? 'agentmail' : smtp ? 'smtp' : null;
  const recipient = process.env.DIGEST_TO?.trim() || process.env.SHOPPING_EMAIL_TO?.trim() || null;
  return {
    provider,
    digestEnabled: process.env.DIGEST_ENABLED === '1',
    recipient,
    inbox: process.env.AGENTMAIL_INBOX?.trim() || null,
    agentKeyTail: agent ? tail(agentKey()) : null,
    smtp: smtp
      ? {
          host: process.env.SMTP_HOST?.trim() ?? '',
          port: Number(process.env.SMTP_PORT ?? 587),
          secure: process.env.SMTP_SECURE === 'true',
          user: process.env.SMTP_USER?.trim() ?? '',
          from: process.env.SMTP_FROM?.trim() ?? '',
          passTail: tail(process.env.SMTP_PASS),
        }
      : null,
  };
}

interface EmailBody {
  provider: 'agentmail' | 'smtp' | 'none';
  recipient?: string;
  digestEnabled?: boolean;
  agentmailApiKey?: string | null;
  agentmailInbox?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string | null;
  smtpFrom?: string;
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings/email', async () => currentStatus());

  app.post('/settings/email', async (req, reply) => {
    const b = req.body as EmailBody;
    const recipient = b.recipient?.trim();
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      return reply.code(400).send({ error: 'A valid recipient email is required.' });
    }

    // "keep existing secret" semantics: undefined/'' leaves the stored value,
    // explicit null clears it.
    const patch: Record<string, string> = {
      SHOPPING_EMAIL_TO: recipient,
      DIGEST_TO: recipient,
      DIGEST_ENABLED: b.digestEnabled ? '1' : '0',
    };

    if (b.provider === 'agentmail') {
      const inbox = b.agentmailInbox?.trim();
      if (!inbox) return reply.code(400).send({ error: 'AgentMail needs an inbox name.' });
      if (b.agentmailApiKey === null) patch.AGENTMAIL_API_KEY = '';
      else if (b.agentmailApiKey) patch.AGENTMAIL_API_KEY = b.agentmailApiKey.trim();
      if (!agentKey() && !b.agentmailApiKey) {
        return reply.code(400).send({ error: 'AgentMail needs an API key (paste it, or configure AGENTMAIL_API_KEY first).' });
      }
      patch.AGENTMAIL_INBOX = inbox;
      // switching channel — neutralize the other one
      patch.SMTP_HOST = '';
      patch.SMTP_USER = '';
      patch.SMTP_PASS = '';
    } else if (b.provider === 'smtp') {
      const host = b.smtpHost?.trim();
      if (!host) return reply.code(400).send({ error: 'SMTP needs a host.' });
      patch.SMTP_HOST = host;
      patch.SMTP_PORT = String(b.smtpPort ?? 587);
      patch.SMTP_SECURE = b.smtpSecure ? 'true' : 'false';
      patch.SMTP_USER = b.smtpUser?.trim() ?? '';
      if (b.smtpPass === null) patch.SMTP_PASS = '';
      else if (b.smtpPass) patch.SMTP_PASS = b.smtpPass;
      patch.SMTP_FROM = b.smtpFrom?.trim() || b.smtpUser?.trim() || '';
      patch.AGENTMAIL_API_KEY = '';
      patch.AGENTMAIL_INBOX = '';
    } else if (b.provider === 'none') {
      patch.AGENTMAIL_API_KEY = '';
      patch.AGENTMAIL_INBOX = '';
      patch.SMTP_HOST = '';
      patch.SMTP_PORT = '';
      patch.SMTP_SECURE = '';
      patch.SMTP_USER = '';
      patch.SMTP_PASS = '';
      patch.SMTP_FROM = '';
      patch.DIGEST_ENABLED = '0';
    } else {
      return reply.code(400).send({ error: 'provider must be agentmail, smtp or none.' });
    }

    upsertEnv(patch);
    return currentStatus();
  });

  // Sends a short test email through the configured channel. Uses the saved
  // config (save first); errors surface as 400/502 with a readable message.
  app.post('/settings/email/test', async (req, reply) => {
    if (!agentKey() && !process.env.SMTP_HOST?.trim()) {
      return reply.code(400).send({ error: 'No email provider configured — save a provider first.' });
    }
    const now = new Date().toLocaleString();
    try {
      const r = await sendDigestEmail(
        'Schei — test email',
        `It works. Sent ${now} from your local Schei.\n\nShopping lists and the weekly Monday-08:00 digest will arrive from the same channel.`,
        `<p>It works. Sent ${now} from your local Schei.</p><p>Shopping lists and the weekly Monday-08:00 digest will arrive from the same channel.</p>`,
      );
      return r;
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
