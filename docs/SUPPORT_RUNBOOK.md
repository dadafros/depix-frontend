# Wallet Support Runbook

Resposta de suporte para os 3 cenários de perda mais comuns na wallet Liquid
não-custodial (Fase 1). **Premissa: a wallet é não-custodial. O operador do
backend NÃO tem acesso às 12 palavras nem ao PIN do usuário.** Isso define os
limites do que suporte pode fazer.

## Árvore de decisão

```
Usuário reportou problema de acesso à wallet
│
├── Tem as 12 palavras? ──── SIM ──┐
│                                  │
│                                  ├── Tem o celular com a wallet?
│                                  │    ├── SIM → Cenário 1 (só esqueceu o PIN)
│                                  │    └── NÃO → Cenário 2 (perdeu o celular)
│                                  │
└── NÃO ──────────────────────────────→ Cenário 3 (perda total)
```

## Cenário 1 — Perdeu só o PIN

**Sintoma**: usuário ainda tem o celular e as 12 palavras anotadas, mas
esqueceu o PIN de 6 dígitos que autoriza envios.

**Resposta ao usuário** (copiar/colar):

> Tudo bem, vamos resolver. Como você tem as 12 palavras anotadas, o caminho
> mais seguro é apagar a carteira desse celular e restaurar com as palavras —
> isso reconfigura o PIN do zero.
>
> 1. No app, abra Minha Carteira → Configurações da carteira → Apagar carteira.
>    Confirme a operação.
> 2. Se você não lembrar o PIN para confirmar o apagamento, basta errar o PIN 5
>    vezes seguidas em qualquer tela de envio. A carteira será apagada
>    automaticamente deste celular (os fundos ficam seguros, protegidos pelas
>    12 palavras).
> 3. Toque em Criar/Restaurar → Restaurar → digite as 12 palavras na ordem em
>    que você anotou.
> 4. Crie um PIN novo. Use algo que você vá lembrar.
>
> Depois disso, a wallet volta com todos os saldos e o histórico.

**Escalação**: nenhuma. Suporte não precisa envolver engenharia.

## Cenário 2 — Perdeu o celular (mas tem as 12 palavras)

**Sintoma**: celular roubado/quebrado/perdido. Usuário tem as 12 palavras
anotadas em papel.

**Resposta ao usuário**:

> Sem problema, seus fundos estão seguros. As 12 palavras são a única coisa
> que importa para recuperar a carteira.
>
> Você tem duas opções:
>
> **Opção A — Recuperar no DePix App (novo celular)**:
> 1. Instale o DePix App no novo celular.
> 2. Faça login com seu usuário e senha do app.
> 3. Abra Minha Carteira → Restaurar → digite as 12 palavras.
> 4. Crie um PIN novo.
>
> **Opção B — Recuperar no SideSwap (acesso imediato)**:
> 1. Baixe o app SideSwap.
> 2. Na tela inicial, escolha "Restaurar carteira" e digite as 12 palavras.
> 3. Você terá acesso aos mesmos fundos. As duas carteiras (DePix App e
>    SideSwap) são equivalentes — mesma seed, mesmos saldos.

**Escalação**: nenhuma. Se o usuário reportar que o celular foi roubado e
há preocupação com segurança da conta (não da wallet), siga o runbook de
conta comprometida (reset de senha + logout de todos os devices).

## Cenário 3 — Perdeu PIN E palavras

**Sintoma**: usuário esqueceu ou perdeu as 12 palavras. Pode ou não ter o
celular em mãos.

**Resposta ao usuário** (crítico: seja honesto):

> Precisamos ser transparentes aqui. A carteira DePix é não-custodial: ela é
> protegida pelas 12 palavras que só você tem. Nem o DePix App, nem a nossa
> equipe, nem ninguém mais tem cópia dessas palavras — essa é a garantia de
> que só você controla o dinheiro.
>
> Isso significa que, **sem as 12 palavras, não é possível recuperar os
> fundos**. Não existe "reset de senha" para a carteira.
>
> Se o celular ainda está em suas mãos e a carteira está desbloqueada:
> 1. Abra Minha Carteira → Configurações da carteira → Exportar 12 palavras
>    (precisa do PIN).
> 2. Anote as 12 palavras em papel AGORA. Guarde em local seguro.
> 3. Faça isso antes de fechar o app.
>
> Se a carteira já está bloqueada e você também perdeu o PIN, não há caminho
> de recuperação. Nossa recomendação é tratar a wallet como esvaziada — se
> você estiver recebendo novos depósitos nela, pare imediatamente e configure
> uma nova wallet (com backup em papel dessa vez).

**Escalação**: envolva engenharia APENAS se houver suspeita de bug (por
exemplo, usuário jura que anotou as palavras e o restore está falhando
mesmo com as palavras corretas). Nesse caso:

1. Coletar a versão do app (menu → Sobre).
2. Confirmar que o usuário está digitando todas as 12 palavras em ordem,
   tudo minúsculo, sem espaços extras.
3. Confirmar que o checksum BIP39 não está falhando (mensagem "Combinação
   inválida" na tela de restore).
4. Se tudo acima confere e ainda falha, abrir issue no repo com as
   informações (sem as palavras, obviamente).

## Quando envolver engenharia

**Nunca** por:
- PIN esquecido (Cenário 1 se resolve sozinho)
- Celular perdido com palavras em papel (Cenário 2 se resolve sozinho)
- Palavras perdidas (Cenário 3 não tem solução técnica)

**Sempre** por:
- Suspeita de bug no fluxo de restore (usuário jura que digitou correto)
- Usuário reporta saldo zerado sem ter enviado nada
- Banner de manutenção ativo E usuário não consegue ver saldo

## Escalação de segurança

Se o usuário reportar:
- Wallet comprometida (fundos saíram sem autorização)
- Device comprometido (malware detectado)
- Frase de backup possivelmente vazada (ex: fotografou e subiu pra nuvem)

→ Encaminhe IMEDIATAMENTE para `docs/SECURITY_RESPONSE.md`.
