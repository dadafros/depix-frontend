# iOS PWA Smoke — Wallet (Fase 1)

Checklist manual pra smoke da wallet em Safari iOS instalado como PWA
standalone. **Este teste não tem automação** — Playwright em CI não
cobre iOS PWA real por duas razões:

1. `webkit` do Playwright é WebKit desktop, não iOS Safari. Diferenças
   em PRF (WebAuthn), IndexedDB eviction, cache do service worker.
2. PWA standalone muda headers e behaviors — `navigator.standalone`,
   cold start sem tab, suspensão mais agressiva.

Smoke é executado por um humano antes de cada release que toca a wallet.
Duração: ~15 min em iPhone real.

## Pré-requisitos

- iPhone com iOS 18+ (requisito pra PRF; iOS ≤ 16 cai pra PIN-only).
- Safari atual (não in-app browser).
- Pelo menos 1 Face ID ou Touch ID enrollado no device.
- Rede estável (cellular ou Wi-Fi) pra fetch inicial do WASM.

## Fluxo mínimo (smoke)

### 1. Instalação como PWA

- [ ] Abrir https://depixapp.com em Safari.
- [ ] Share sheet → "Adicionar à Tela de Início".
- [ ] Abrir pelo ícone da home screen — app abre em standalone
      (sem barra do Safari).
- [ ] Login com conta de teste.

### 2. Criar wallet + backup + biometria

- [ ] Entrar em "Criar carteira".
- [ ] Tela 1 — marcar os 2 checkboxes + botão "Mostrar palavras".
- [ ] Tela 2 — anotar as 12 palavras **em papel** (nunca print/clipboard).
- [ ] Tela 3 — verificar as 4 posições corretamente.
- [ ] Tela 4 — criar PIN de 6 dígitos (evitar `000000`, datas 19XX/20XX).
- [ ] Tela 5 — "Ativar biometria" → Face ID/Touch ID prompt. Autorizar.
- [ ] Tela 6 — "Ativada". Navegar pra home.

**Verificar**: toggle de 3 modos (Depósito / Saque / Minha Carteira) visível.

### 3. Cold start + cache do WASM

- [ ] Fechar PWA completamente (swipe up no app switcher).
- [ ] Aguardar ~1min (permite o SW suspender).
- [ ] Reabrir PWA pelo ícone.

**Verificar**:
- [ ] Home aparece em <3s (WASM servido do cache do SW).
- [ ] Saldos carregam (requer re-sync via Esplora — pode demorar 5-10s).
- [ ] Nenhum spinner infinito. Se WASM não carrega em 10s, banner
      degradado aparece ("Carteira temporariamente indisponível").

### 4. Receive + QR

- [ ] Entrar em "Minha Carteira" → "Receber".
- [ ] Endereço `lq1...` aparece.
- [ ] Botão copiar → toast "Endereço copiado".
- [ ] Botão QR → modal fullscreen com QR escaneável (testar com outro
      celular lendo o QR).

### 5. Send com biometria (o teste chave)

- [ ] Depositar R$1 na própria wallet via depósito (gera QR PIX, pagar
      com outro app PIX).
- [ ] Aguardar confirmação do DePix (até 30s).
- [ ] Voltar em "Minha Carteira" → "Pagar" → DePix → inserir endereço
      Liquid externo (pode ser SideSwap do próprio dev).
- [ ] Valor R$0.50 → "Continuar" → modal de confirmação.
- [ ] Ao clicar "Enviar", Face ID/Touch ID prompt sobe.
- [ ] Autorizar com biometria → tx assina e faz broadcast.
- [ ] Tela de sucesso mostra txid.

**Verificar**:
- [ ] Biometria foi o **primeiro** prompt (não PIN). PIN só apareceria
      se biometria falhasse.
- [ ] txid `64 chars hex` na tela de sucesso.
- [ ] Tx aparece no histórico dentro de 1 bloco Liquid (~1min).

### 6. PIN fallback

- [ ] Settings da wallet → "Remover biometria".
- [ ] Voltar pra send → tentar enviar R$0.50.
- [ ] Desta vez aparece prompt de PIN (não biometria).
- [ ] PIN correto → broadcast.

### 7. Kill switch (opcional se ambiente de staging)

- [ ] Ativar `WALLET_KILL_SWITCH=1` no staging.
- [ ] Reabrir PWA (após 5min do cache TTL).
- [ ] Verificar banner laranja de manutenção visível.
- [ ] Verificar view-only ainda funciona (saldo + receber + histórico).
- [ ] Verificar que toggle "Minha Carteira" some se criar uma conta
      **nova** (sem wallet ainda).

## Edge cases pra explorar

Se o tempo permitir, testar também:

- **IndexedDB eviction**: Settings do iOS → Safari → Apagar cache/dados.
  PWA deve detectar que wallet sumiu e pedir restore com 12 palavras.
  Saldos reaparecem depois do restore.
- **Low battery mode**: iOS agressivamente suspende service workers.
  Reabrir PWA e verificar se WASM re-fetcha ou cai no cache.
- **Avião (offline)**: toggle airplane mode → abrir PWA → view-only
  deve funcionar com saldo stale. Send deve falhar com erro amigável
  ("Sem conexão, tente novamente").

## O que NÃO é coberto aqui

- Android Chrome/Firefox — testado via Playwright em CI (`webkit` do
  Playwright e Chromium nativo cobrem esses combos).
- Desktop — idem, Playwright CI.
- iOS ≤ 16 — sem PRF, PIN-only. Não é target v1.
- Edge cases de combinação específica (Face ID + trocar pra Touch ID no
  mesmo device — edge com zero uso real).

## Cadência

- **Antes de cada release** que toca `wallet/`, `script.js`
  (handlers de deposit/withdraw integrados), `service-worker.js`, ou
  `index.html` (views de wallet).
- **Report reativo** pra combos não cobertos — se um user relata bug no
  iPhone SE 3gen (A15, iOS 18), adiciona ao checklist e testa em
  release seguinte.

## Quem executa

- Default: o dev que está fazendo o release.
- Backup: outro dev do time se o primário não estiver disponível.
- **Nunca** ship sem o smoke passar. Se iPhone físico indisponível,
  adiar o release.

## Log de execuções

Adicione uma linha por smoke executado:

| Data | Commit | Device | iOS | Resultado |
|------|--------|--------|-----|-----------|
| (primeiro smoke após gap 5) | | | | |
