# Privacy Threat Model — Wallet (Fase 1)

Identifica quais informações pessoais passam a circular com a wallet
integrada, onde ficam, quem consegue correlacionar o que, e que defesas
estão em lugar. Este doc é a referência pro suporte e pra auditoria
interna — quando alguém pergunta "o backend sabe o que o user comprou?",
é aqui que mora a resposta.

## Escopo

Cobre apenas o que a wallet Liquid no PWA (sub-fases 2–6) adiciona em
cima do DepixApp já existente. Fluxo PIX↔DePix com API Eulen não mudou;
o backend e a Eulen continuam vendo exatamente os mesmos campos de antes.

## Entidades

| Entidade | Papel | Dados que vê |
|----------|-------|--------------|
| **User (lojista)** | Dono da seed + PIN + device | Tudo sobre a própria conta |
| **Frontend (browser)** | Cliente PWA | Seed em memória (destravada), descriptor plaintext no IndexedDB |
| **Backend (depix-backend on Vercel)** | API própria | JWT, CNPJ/CPF do user (login), `depixAddress`, `pixKey`, valor, `liquid_txid` (quando arquivado) |
| **Eulen (PIX↔DePix)** | Custódia PIX | `depixAddress`, `pixKey`, valor, `depositAddress` deles mesmos |
| **Blockstream Esplora público** | Index da Liquid | IPs de quem consulta endereços + lista de endereços consultados |
| **Bitfinex / cotador externo** | Preço BTC/USD + USD/BRL | Só IP do backend (user nunca chama direto) |

## O que é novo com a wallet

### Novo: `liquid_txid` no backend

- Endpoint `POST /api/withdraw/txid` é chamado pela wallet após broadcast
  bem-sucedido do saque. Payload: `{ withdrawalId, liquidTxid }`.
- Persistido em `saques.liquid_txid` (nullable, só presente quando o user
  tem wallet e o broadcast via wallet completou).
- Serve pra **reconciliação de suporte** — quando o user liga "meu PIX
  não chegou", a gente consegue olhar no Esplora o que aconteceu com o
  txid na Liquid side.

### Ameaça: unmasking CPF ↔ Liquid tx

Com `liquid_txid` + `saques.user_id` + `users.cpf`, um atacante com
acesso admin ao banco pode correlacionar:

```
cpf (de users) → user_id → saques.liquid_txid → endereço Liquid
  → histórico on-chain via Esplora → todas as txs envolvendo esse endereço
```

Isso **sempre existiu** pro fluxo PIX→DePix (o `depixAddress` já é
gravado em `depositos.destino_liquid`). A wallet amplifica a correlação
porque agora o mesmo user tem:

1. Endereço de depósito (DePix chegando — já existia)
2. Endereço de saque = endereço da wallet (DePix indo — novo)
3. Txid Liquid do saque (novo, conecta saque off-chain ↔ on-chain)

O ponto 3 é o incremento. O 1 e 2 já permitiam ligar endereços ao CPF
— não é wallet-specific.

### Mitigações em vigor

- **Acesso a `saques.liquid_txid` requer auth admin**. A API só expõe o
  campo pro próprio user (`GET /api/withdrawals` filtrado por `user_id`);
  admins veem via console Turso. Admins são 2 pessoas hoje, ambas
  signatárias do contrato de sócios.
- **Logs de acesso admin ao Turso** — toda query vem com usuário nomeado;
  audit log da Turso guarda histórico. Em caso de vazamento, a gente
  sabe quem abriu o quê.
- **Nenhum endpoint público cruza `liquid_txid` com `cpf`**. O frontend
  não expõe txid pra outros users. Um atacante externo precisaria
  comprometer a conta admin primeiro.
- **Esplora pública não é chamada com tokens/cookies do user**. Qualquer
  correlação via Esplora só revela IPs — e a gente usa Esplora do
  backend (proxy de histórico) ou via fetch do frontend (mistura user's
  IP com milhares de outros clientes do mesmo Esplora). Baixo sinal.

### Defesas adicionais consideradas (não implementadas v1)

| Defesa | Por que não fez | Quando reconsiderar |
|--------|-----------------|---------------------|
| Hash one-way de `liquid_txid` no banco | Impossibilitaria reconciliação via `GET /api/withdraw/txid` por `withdrawalId` + txid. O objetivo da coluna é a reconciliação, não storage cego | Se a coluna virar public-read |
| Deletar `liquid_txid` após X dias | Perde capacidade de suporte pra reclamações antigas | Se legislação exigir |
| Tor / proxy pra Esplora | Overhead de operação. Esplora pública já é anonimizada via shared IPs | Se Esplora começar a bloquear o backend |

## Ameaça: device comprometido

Se o device do user é comprometido (malware, acesso físico, tortura):

- **Seed**: no IndexedDB encriptada com PIN (Argon2id m=19MiB, t=2). Sem
  o PIN, um dump do IndexedDB resiste a ~11 dias de compute local com
  hardware comum (tentativa 1M PINs × 1s).
- **Descriptor plaintext**: o atacante vê histórico e saldos mas não
  pode gastar.
- **`failedPinAttempts`**: pode ser zerado manualmente via DevTools —
  **reconhecido**. Defesa primária é Argon2id; contador é UX + barreira
  casual.

Nenhuma defesa browser-based é perfeita contra root physical access.
Saldos altos devem migrar pra hardware wallet (documentado no onboarding).

## Ameaça: supply-chain (npm)

`hash-wasm` e `lwk_wasm` são deps críticos. Comprometimento de qualquer
um dos dois permitiria:

- Exfiltrar seed do closure do wallet module (via prototype pollution
  ou patch do próprio método de crypto)
- Assinar transações diferentes das que o user vê

### Mitigações

- **CSP strict**: `script-src 'self' 'wasm-unsafe-eval'`. Bloqueia
  eval() arbitrário e inline scripts. Ataque precisa injetar código
  no bundle de build, não runtime.
- **Lockfile commitado** (`package-lock.json`). Mudanças em deps passam
  por PR humano.
- **Auditoria de deps periódica**. `npm audit` antes de cada release.
- **Runbook** `SECURITY_RESPONSE.md` tem o comando de kill switch
  pronto — se vazamento confirmado, wallet some do frontend em <5min
  (TTL do cache de `/api/config`).

Reconhecido em `docs/AUDITORIA-FASE-1-WALLET.md` (SEC-06) que defesa
100% em JS puro contra supply-chain é impossível; documentado e aceito.

## Ameaça: backend compromised

Se o backend do DepixApp é comprometido, o atacante:

- Sabe `cpf`, `pixKey`, `depixAddress` de depósitos e saques — mesmo
  antes da wallet existir.
- Ganha `liquid_txid` pra saques recentes — correlação on-chain facilitada.
- **Não consegue gastar fundos da wallet** — seed nunca entra no backend.

A premissa não-custodial da wallet sobrevive a um backend compromised.
Esse é o principal ganho vs. um modelo custodial.

## Ameaça: Eulen comprometida

Eulen já tem acesso a `pixKey` + `depositAddress` (dela) + valor. Com
a wallet, continua vendo o mesmo payload — `depixAddress` continua
sendo enviado, apenas com origem diferente.

**Nada novo pra Eulen** com a wallet. Fluxo idêntico.

## Dados sensíveis que NUNCA saem do device

- **Seed (mnemonic)** — só em memória + encriptada no IndexedDB.
- **PIN** — nunca trafegado. Derivado localmente via Argon2id.
- **PRF secret do WebAuthn** — gerado pelo authenticator, nunca sai do
  hardware.

## Telemetria — o que a gente sabe

`POST /api/wallet/telemetry` aceita 7 eventos anônimos. Sem `user_id`,
sem IP, sem saldos, sem endereços.

Eventos: `wallet.created`, `wallet.wiped`, `biometric.enroll.success`,
`biometric.enroll.failed`, `unlock.pin.wrong`, `send.broadcast.failed`,
`wasm.load.timeout`.

Agregado em Upstash sorted sets TTL 90 dias. Admin summary
(`GET /api/wallet/telemetry/summary`, admin-only via
`TELEMETRY_ADMIN_TOKEN`) retorna apenas counts.

Não dá pra ligar evento → user.

## Checklist de compliance

- [ ] LGPD — lista de dados pessoais tratados está em `docs/PRIVACY.md`
      (doc separado, lista legal). Este threat model é o complemento
      técnico.
- [ ] Direito ao esquecimento — quando user pede wipe, a gente apaga:
      (a) `users` row, (b) `depositos` e `saques` (inclui `liquid_txid`),
      (c) `wallet.telemetry` — mas aí não tem PII pra remover, é
      agregado anônimo. Documentado no `SUPPORT_RUNBOOK.md`.
- [ ] Criptografia at-rest — Turso dá encryption at-rest; IndexedDB no
      device usa AES-GCM 256 pelo próprio browser.

## Mudanças que disparam revisão deste doc

Revisar este threat model se qualquer um destes mudar:

- Adicionar novo endpoint que exponha `liquid_txid` publicamente.
- Trocar Esplora público por fonte cativa (Blockstream enterprise tier).
- Adicionar PII adicional à telemetria.
- Mudar premissa não-custodial (ex.: backup server-side — não
  planejado, mas se algum dia…).
- Integrar com SideSwap server (fase 2) — swap DePix↔USDT introduz
  nova contraparte que vê endereços da wallet.

Última revisão: 2026-04-22 (sub-fase 6 + gaps).
