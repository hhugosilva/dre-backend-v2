# DRE Fácil — Backend

API REST do aplicativo DRE Fácil, hospedada no Railway.

**URL de produção:** `https://dre-backend-v2-production.up.railway.app`

---

## Tecnologias utilizadas

| Tecnologia | Versão | Função |
|---|---|---|
| Node.js | 18+ | Runtime do servidor |
| Express | 4.18 | Framework HTTP |
| MySQL 2 | 3.6 | Driver do banco de dados |
| bcryptjs | 2.4 | Hash de senhas |
| jsonwebtoken | 9.0 | Autenticação JWT |
| Anthropic SDK | 0.39 | IA para classificação de lançamentos e leitura de PDFs |
| pdf-parse | 1.1.1 | Extração de texto de PDFs bancários |
| nodemailer | 8.0 | Dependência de e-mail (Brevo REST API usada diretamente) |
| dotenv | 16 | Variáveis de ambiente |

**Hospedagem:** Railway (PaaS)  
**Banco de dados:** MySQL gerenciado pelo Railway (com backup automático diário)  
**E-mail transacional:** Brevo REST API (300 e-mails/dia grátis)

---

## Arquitetura

```
Cliente (React Native)
        │
        │ HTTPS + JWT
        ▼
  Express (Railway)
        │
        ├── Auth routes     /api/auth/*
        ├── DRE routes      /api/dre/*
        ├── Config routes   /api/config/*
        └── AI routes       /api/ai/*
              │
              ├── MySQL (dados dos usuários, DREs, configurações)
              ├── Anthropic API (Claude — classificação de transações)
              └── Brevo API (envio de e-mails OTP)
```

---

## Banco de dados

### Tabelas

**`dre_users`** — Usuários
```
id, nome, nome_empresa, cnpj, email, senha (bcrypt),
provider (local/google), email_verificado,
two_factor_enabled, totp_enabled,
verify_token, reset_token, reset_expires,
created_at
```

**`dre_historico`** — DREs salvas por mês
```
id, user_id, mes_key (YYYY-MM), period,
receita, custos (JSON), total_custo, lucro,
by_forn_raw (JSON), forn_config (JSON),
saved_at, updated_at
```

**`dre_config`** — Configurações por usuário
```
id, user_id, categories (JSON), rules (JSON),
fornecedores (JSON), updated_at
```

---

## Autenticação

### Fluxo de cadastro (com verificação de e-mail)
```
1. POST /api/auth/send-register-code   → valida dados, envia código OTP por e-mail
2. POST /api/auth/confirm-register-code → valida código, cria conta, retorna JWT
```
A conta só é criada após o código correto ser informado — evita cadastros com e-mail inválido.

### Fluxo de login
```
1. POST /api/auth/login
   → Se 2FA desativado: retorna { token, user }
   → Se 2FA ativado:    retorna { twoFactorRequired: true, userId }

2. POST /api/auth/verify-2fa → valida código OTP, retorna { token, user }
```

### JWT
- Expiração: **30 dias**
- Payload: `{ id, nome, email }`
- Middleware `auth` protege todas as rotas privadas

---

## Endpoints principais

### Auth
| Método | Rota | Auth | Descrição |
|---|---|---|---|
| POST | `/api/auth/send-register-code` | ❌ | Envia código de cadastro |
| POST | `/api/auth/confirm-register-code` | ❌ | Confirma código e cria conta |
| POST | `/api/auth/login` | ❌ | Login com e-mail e senha |
| POST | `/api/auth/verify-2fa` | ❌ | Valida código 2FA |
| GET | `/api/auth/me` | ✅ | Retorna dados do usuário logado |
| PUT | `/api/auth/profile` | ✅ | Atualiza nome, empresa, senha |
| PUT | `/api/auth/toggle-2fa` | ✅ | Ativa/desativa verificação em 2 etapas |
| DELETE | `/api/auth/account` | ✅ | Exclui conta e todos os dados |
| POST | `/api/auth/forgot-password` | ❌ | Envia link de redefinição de senha |
| GET | `/api/auth/google/start` | ❌ | Inicia OAuth com Google |

### DRE
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/dre/list` | Lista todas as DREs do usuário |
| POST | `/api/dre/save` | Salva ou atualiza uma DRE |
| GET | `/api/dre/:mesKey` | Busca DRE de um mês específico |
| DELETE | `/api/dre/:mesKey` | Apaga DRE de um mês |

### Config
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/config` | Busca categorias, regras e fornecedores |
| PUT | `/api/config` | Salva configurações |

### IA (Anthropic Claude)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/ai/classify` | Classifica transações por categoria usando IA |
| POST | `/api/ai/parse-pdf` | Extrai lançamentos de extrato PDF |
| POST | `/api/ai/parse-extract` | Interpreta extrato em texto puro |

---

## Variáveis de ambiente (Railway)

```env
MYSQLHOST, MYSQLPORT, MYSQLDATABASE, MYSQLUSER, MYSQLPASSWORD
JWT_SECRET
ANTHROPIC_API_KEY
BREVO_API_KEY
BREVO_FROM_EMAIL
GOOGLE_CLIENT_SECRET
APP_URL
```

---

## Como rodar localmente

```bash
# Clonar e instalar dependências
npm install

# Criar arquivo .env com as variáveis acima
cp .env.example .env

# Rodar em desenvolvimento
npm run dev

# Rodar em produção
npm start
```

---

## Deploy

```bash
# Deploy para o Railway
railway up --detach
```

O Railway detecta o `Procfile` e executa `node index.js`.

---

## Segurança implementada

- **Senhas:** hash com `bcrypt` (salt rounds: 10) — nunca armazenadas em texto puro
- **Autenticação:** JWT com expiração de 30 dias
- **2FA / MFA:** código OTP de 6 dígitos via e-mail, válido por 10 minutos
- **Cadastro verificado:** conta só criada após confirmação do e-mail
- **Controle de acesso:** middleware JWT em todas as rotas privadas
- **Validação de entradas:** campos obrigatórios validados em cada rota
- **Erros HTTP:** códigos semânticos (400, 401, 404, 409, 500)
- **HTTPS:** obrigatório via Railway
- **Dados isolados:** todas as queries filtradas por `user_id`
- **Exclusão em cascata:** ao deletar conta, todos os dados são removidos (FOREIGN KEY CASCADE)
- **Backup:** automático diário pelo Railway MySQL
