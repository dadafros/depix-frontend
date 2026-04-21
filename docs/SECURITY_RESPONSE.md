# Security Response — Wallet (Fase 1)

Skeleton para incident response da wallet Liquid não-custodial. Atualize este
doc com o primeiro incidente real — ele é proposital curto agora.

## Contatos

| Papel | Contato | Notas |
|-------|---------|-------|
| Eng. lead (wallet) | @davi_bf | Primary on-call |
| Backend ops | (TBD) | Kill-switch deploy |
| Comunicação externa | (TBD) | Template de user comms |

## Runbook rápido

### 1. Ativar kill switch (parar novas wallets imediatamente)

No backend, defina `WALLET_KILL_SWITCH=1` no env de produção e redeploy:

```bash
cd depix-backend
vercel env add WALLET_KILL_SWITCH production  # valor: 1
vercel deploy --prod
```

Efeito:
- `GET /api/config` passa a retornar `{ walletEnabled: false }`.
- Frontend esconde toggle "Minha Carteira" para users sem wallet.
- Users com wallet veem banner laranja de manutenção + view-only.
- Fluxos de criar/restaurar ficam bloqueados (redirect pra `#home`).
- **Sem force-wipe remoto** — IndexedDB local fica intocado.

### 2. Reverter kill switch

```bash
vercel env rm WALLET_KILL_SWITCH production
vercel deploy --prod
```

Frontend refaz fetch a cada 5min (TTL do cache), então a reativação demora
no máximo 5min por usuário. Reset imediato via reload do app.

### 3. Template de comunicação externa

TODO: escrever no primeiro incidente. Placeholder:

> Identificamos um problema técnico na carteira Liquid integrada ao DePix App.
> Sua wallet e seus fundos estão seguros — suas 12 palavras não foram
> expostas. Temporariamente, novos envios pelo app estão pausados enquanto
> investigamos. Se precisar mover fundos agora, use suas 12 palavras no app
> SideSwap. Avisaremos quando a operação normal for retomada.

## Disclosure externo

Se um pesquisador ou usuário reportar uma vulnerabilidade na wallet:

1. **Não discuta publicamente** antes do fix. Peça ao reporter uma janela
   privada de comunicação (email).
2. **Ative kill switch** se o reporter demonstrar capacidade real de
   exfiltrar seeds ou forjar assinaturas.
3. **Reproduza** a vulnerabilidade num ambiente de dev.
4. **Fix** no código, teste, deploy.
5. **Comunique** os usuários afetados (ver template acima), agradeça o
   reporter publicamente após o fix.

## Threat model referenciado

Ver `docs/WEBAUTHN_MATRIX.md` para device compatibility e
`docs/LWK_AUDIT.md` para suposições sobre a biblioteca LWK upstream.
Atualize ambos quando um incidente contradisser o modelo.
