# Accessibility Checklist — Wallet (Fase 1)

Gate list para os fluxos novos da wallet (onboarding, home, send/receive,
settings). A base WCAG 2.1 AA é assumida; esta lista cobre só os pontos
específicos do wallet que têm histórico de falhar ou que a audiência
(lojistas leigos) depende com mais frequência.

Sinalize cada item ao revisar um PR. "N/A" é aceito desde que tenha
justificativa escrita no PR.

## 1. Onboarding — 12-word backup + PIN + biometric

### 1.1 BIP39 word grid (`#wallet-create-seed`)

- [ ] Cada palavra tem `aria-label="palavra N: <word>"` pra screen reader
      ler "palavra 3: winner" em vez do DOM cru.
- [ ] `role="list"` no container, `role="listitem"` em cada célula — sem
      isso o VoiceOver ignora que as 12 palavras formam um grupo.
- [ ] `user-select: none` aplicado via CSS (não via `oncopy` JS) — screen
      reader ainda consegue ler; só o copy-paste pelo cursor é bloqueado.
- [ ] Contraste das palavras ≥ 4.5:1 contra o fundo dark teal. Teste com
      WebAIM contrast checker, não só "parece ok".

### 1.2 Verification (`#wallet-create-verify`)

- [ ] Os 4 inputs de posição têm `aria-label="posição N do backup"`.
- [ ] Cada botão de escolha (3 opções por posição) tem focus visível — não
      remova `outline` sem substituir por `:focus-visible` com box-shadow
      equivalente.
- [ ] Navegação por teclado: Tab percorre as 4 posições na ordem; Enter/Space
      seleciona. Sem precisar de mouse/touch.
- [ ] O modal pedagógico de erro recebe `role="alertdialog"`, foco inicial
      no botão "Entendi", Escape fecha.

### 1.3 PIN input (`#wallet-create-pin`)

- [ ] `inputmode="numeric"` e `type="password"` (oculta dígitos, teclado
      numérico em mobile).
- [ ] `autocomplete="new-password"` pra evitar que o gerenciador sugira
      senhas antigas do login do app.
- [ ] Mensagem "PIN muito comum" vira `role="alert"` pra screen reader
      anunciar sem depender do user voltar o foco.
- [ ] Confirmação (digitar de novo) tem `aria-label="confirme o PIN"` —
      mesmo visual do primeiro, mas screen reader distingue.

### 1.4 Biometric enroll (`#wallet-create-biometric`)

- [ ] Botão "Ativar biometria" tem `aria-label` explícito ("Ativar Face ID"
      ou "Ativar Touch ID" conforme device — detectar no enroll).
- [ ] Botão "Pular" tem contraste suficiente pra não parecer desabilitado —
      `.btn-secondary` com `color: var(--fg-muted)` e ≥4.5:1.
- [ ] Se o prompt WebAuthn falha, copy do erro fica visível E lida via
      `role="alert"` — não só console.log.

### 1.5 Restore input (`#wallet-restore-input`)

- [ ] 12 inputs separados com `aria-label="palavra N"`, Tab navega em
      ordem, sem grupo nem fieldset adicional necessário.
- [ ] Autocomplete dropdown: ARIA combobox pattern completo
      (`role="combobox"`, `aria-expanded`, `aria-activedescendant` na
      opção focada).
- [ ] Validação BIP39 inválida: borda vermelha + `aria-invalid="true"` +
      `aria-describedby` apontando pra mensagem de erro.
- [ ] Checksum fail: mensagem em `role="alert"` no topo do form (não como
      borda numa palavra específica — não sabemos qual errou).

## 2. Home — "Minha Carteira" toggle + balances

- [ ] Toggle de 3 modos usa `role="radiogroup"` + `role="radio"` nos
      botões, `aria-checked` reflete o estado. Sem isso o screen reader
      anuncia 3 botões soltos em vez de "escolha 1 de 3".
- [ ] Cada asset row (DePix / USDt / L-BTC) tem `aria-label` agregando
      nome + saldo + equivalente BRL — "DePix: 125 reais e 50 centavos".
- [ ] Botões Receber / Pagar / QR têm ícone + texto visível (não só ícone).
      Se só ícone, `aria-label` obrigatório.
- [ ] Banner de manutenção (kill switch) é `role="status"` com
      `aria-live="polite"` — anunciado uma vez ao aparecer, sem spam.

## 3. Send flow — unlock + confirm + broadcast

- [ ] Modal de unlock (`wallet-unlock-prompt`) recebe foco inicial no
      input de PIN (ou botão biométrico se disponível). Escape fecha e
      volta foco ao botão que abriu.
- [ ] Confirmação de envio mostra destino abbreviado + full endereço via
      `aria-label` (screen reader lê o endereço completo). Rule 5 do
      CLAUDE.md sobre truncagem + Rule 2 (min-width: 0) aplica aqui.
- [ ] Botão "Enviar" tem `aria-describedby` apontando pra fee + amount
      line — user ouve "enviar 50 reais para lq1... com taxa de 0.01
      reais" antes de clicar.
- [ ] Tela de sucesso (`wallet-send-success`) tem txid com
      `aria-label="ID da transação"` e botão copy distinto.

## 4. Receive / QR

- [ ] Endereço tem `aria-label="endereço Liquid"` + botão copiar
      adjacente com `aria-label="copiar endereço"`.
- [ ] Toast "Endereço copiado" usa `aria-live="polite"` pra anúncio
      imediato em screen readers.
- [ ] QR fullscreen: `role="img"` no canvas com `aria-label` incluindo
      tipo do asset + fragmento do endereço. Esc fecha (devolve foco ao
      botão QR).

## 5. Settings / revocação

- [ ] "Remover biometria" exige confirmação via modal de alerta
      (`role="alertdialog"`), não só toast.
- [ ] "Exportar 12 palavras" re-prompta PIN (nunca biometria) —
      `role="alertdialog"`, copy explícito sobre risco de mostrar seed
      em local público.
- [ ] "Apagar carteira" → modal vermelho, confirmação dupla (digite o
      PIN). Botão destrutivo fica separado em bloco dedicado, cor
      vermelha mas com contraste ≥ 4.5:1.

## 6. Global (aplica a todos os fluxos novos)

- [ ] **Focus order** — sempre segue a ordem visual top-to-bottom,
      left-to-right. Um `tabindex` inserido pra fora dessa ordem é
      red flag — pergunte pra revisão.
- [ ] **Focus visible** — todos os elementos interativos devem ter um
      `:focus-visible` que seja visualmente distinto. A teal default
      do browser some em fundo escuro; use box-shadow accent.
- [ ] **Contrast AA** nos banners informacionais (maintenance, erro,
      sucesso). Teal accent (#4fd1c5) em fundo teal escuro (#071b1f)
      atinge 10.4:1 — safe. Toasts em cima do fundo verde (#68d391)
      não: use fundo escuro com texto verde pra texto no toast.
- [ ] **Traduções honestas** — copy em pt-BR correto e sem jargão
      técnico ("assine" ≠ "autorize a transação"; "taxa" ≠ "fee").
- [ ] **Reduced motion** — se adicionar qualquer animação (spinner,
      transição), respeite `@media (prefers-reduced-motion: reduce)`.

## Como testar

### Teclado only
Desconecte mouse + trackpad. Passe por todo o fluxo de criar wallet,
receber, enviar, acessar settings. Se algum botão ou ação precisar
mouse, é bug.

### Screen reader
- **macOS**: VoiceOver (Cmd+F5) — navegação com Ctrl+Option+arrows.
- **iOS**: VoiceOver em Settings → Accessibility.
- **Android**: TalkBack.

Fluxo mínimo: receber (ler endereço em voz alta); verificar que toast
"copiado" é anunciado; abrir QR fullscreen e verificar label.

### Contrast
- [axe DevTools](https://www.deque.com/axe/devtools/) como extensão
  Chrome/Firefox. Rode em cada view nova antes de pushar.
- Ou [WebAIM contrast checker](https://webaim.org/resources/contrastchecker/)
  manual pra cores específicas.

### Reduced motion
Chrome DevTools → Rendering → "Emulate CSS media feature
prefers-reduced-motion: reduce". Verifique que animações param.

## Status por sub-fase

Marque conforme cada sub-fase fecha:

- [ ] Sub-fase 3 (onboarding) — requer seções 1.1 a 1.5
- [ ] Sub-fase 4 (home) — requer seção 2
- [ ] Sub-fase 5 (send) — requer seções 3, 4 parcial
- [ ] Sub-fase 6 (integration) — requer seção 2 (kill switch banner)
      + regressão nas seções 1 a 5 após refactor de tests de integração

Revisão final antes do release: seção 6 global + smoke manual com
VoiceOver em iPhone real.
