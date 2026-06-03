# Orquestração Orientada a Issues com o GSD

**Status:** guia de fluxo de trabalho estável
**Público:** desenvolvedores que rastreiam trabalho no GitHub Issues, Linear, Jira ou
sistemas similares de rastreamento de issues e querem conduzir a implementação
assistida por IA através dos primitivos existentes do GSD.

## O que é este guia

Uma receita para combinar comandos que o GSD já inclui em um loop
rastreador de issues → workspace → planejar/executar → verificar/revisar → PR.
É documentação somente. Sem novos comandos, sem daemon, sem integração com
rastreador — cada comando referenciado abaixo já existe no GSD hoje.

O formato é inspirado pela referência de orquestração open-source [Symphony da
OpenAI](https://openai.com/index/open-source-codex-orchestration-symphony/)
([repositório](https://github.com/openai/symphony)). O GSD não vende nem
encapsula o Symphony. Os *conceitos* de orquestração se mapeiam claramente
nos primitivos que o GSD já expõe; este guia apenas descreve esse mapeamento
para que você possa adotar o padrão sem escrever código de integração ou
contornar os controles de segurança do GSD.

## Por que isso existe

O GSD tem os blocos de construção para desenvolvimento de IA orientado a issues —
`/gsd-workspace --new`, `/gsd-manager`, `/gsd-autonomous`, `/gsd-verify-work`,
`/gsd-review`, `/gsd-ship`, além de `STATE.md` e o conjunto de artefatos de fase
— mas não havia um guia que mostrasse como conduzir tudo isso a partir de uma
única issue do rastreador sem escrever scripts de orquestração personalizados.
Sem esse guia, os modos de falha são:

- Subutilização: desenvolvedores executam discuss/plan/execute manualmente e
  nunca recorrem a `/gsd-manager` ou `/gsd-autonomous`, mesmo quando seu padrão
  de trabalho se encaixa.
- Scripts alternativos: desenvolvedores criam loops de shell ad-hoc entre seu
  rastreador e invocações de `claude`, contornando `STATE.md`, o manifesto de
  fases e os controles de verificação.

Este guia torna o loop canônico descobrível.

## Mapeamento de conceitos

Cada linha mapeia um conceito de orquestração no estilo Symphony para o
primitivo do GSD que já o serve. Use esta tabela como chave de tradução ao
ler documentações do Symphony, posts de blog ou descrições de orquestração
de terceiros.

| Conceito Symphony | Primitivo GSD |
|---|---|
| `WORKFLOW.md` (intenção de alto nível) | `ROADMAP.md` (intenção do projeto), `STATE.md` (status em tempo real), `CONTEXT.md` de fase (escopo por fase), `PLAN.md` de fase (etapas executáveis) |
| Um workspace isolado de agente por tarefa | `/gsd-workspace --new --strategy worktree` |
| Despacho e concorrência de agentes | `/gsd-manager` (painel interativo), `/gsd-autonomous` (sem supervisão) |
| Etapas de discussão e planejamento por fase | `/gsd-discuss-phase` → `/gsd-plan-phase` → `/gsd-execute-phase` |
| Prova de trabalho / evidência de testes | `/gsd-verify-work` (UAT.md persistido entre `/clear`) |
| Revisão adversarial | `/gsd-review` (revisão por pares entre IAs do plano) |
| Controle humano de merge | `/gsd-ship` (cria PR, revisão de código opcional, prepara merge) |
| Captura de trabalho subsequente | `/gsd-capture`, `/gsd-capture --seed`, `/gsd-new-milestone`, ou uma issue aberta manualmente no rastreador |
| Controle de concorrência | Semântica de agente gerenciador / segundo plano (sem poller sempre ativo) |

O mapeamento é unidirecional: o GSD é responsável pelos controles de segurança
(verificação, revisão humana, confirmação explícita para criação de trabalho
subsequente). O enquadramento de "orquestração contínua" do Symphony é
intencionalmente não adotado — veja [Não-objetivos](#não-objetivos).

## Fluxo completo

O loop canônico issue → PR, escrito para poder ser executado a partir de uma
única issue do rastreador de ponta a ponta. Substitua os marcadores entre
colchetes antes de executar.

1. **Escolha a issue do rastreador.** Selecione uma issue do seu rastreador
   (GitHub, Linear, etc.) com escopo suficientemente bem definido para
   implementação autônoma — escopo delimitado, critérios de aceitação
   observáveis, sem dependências upstream que bloqueiem a execução.
2. **Mapeie para uma fase do GSD.** Se a issue se mapear para uma fase
   existente em `ROADMAP.md`, selecione-a. Caso contrário, execute
   `/gsd-new-milestone` (para um novo marco de issues relacionadas) ou abra
   uma fase via `/gsd-phase` / `/gsd-phase --insert`. Capture a URL da issue
   do rastreador no `CONTEXT.md` da fase para que a rastreabilidade sobreviva
   à compactação.
3. **Crie um workspace isolado.** Execute
   `/gsd-workspace --new --strategy worktree <slug>` para criar uma git
   worktree com um diretório `.planning/` independente. A worktree é o limite
   de segurança: qualquer exploração, commits parciais ou planos abandonados
   ficam fora do `main`.
4. **Execute discuss → plan → execute através do GSD.** De dentro do
   workspace, execute `/gsd-discuss-phase` para esclarecer ambiguidades,
   `/gsd-plan-phase` para produzir `PLAN.md`, e `/gsd-manager`
   (painel interativo) ou `/gsd-execute-phase` / `/gsd-autonomous`
   (sem supervisão) para implementar. Evite conduzir invocações brutas de
   `claude` de fora do GSD — isso contorna as atualizações de `STATE.md`
   e o manifesto de fases.
5. **Exija prova de trabalho.** Execute `/gsd-verify-work` para conduzir o
   usuário pelo UAT em relação aos critérios de aceitação da fase. Testes,
   capturas de tela, registros de log e diffs de configuração são todos
   gravados em `UAT.md`, que persiste entre `/clear` e alimenta lacunas no
   `/gsd-plan-phase --gaps` quando a verificação revela escopo não coberto.
6. **Passe pelos controles de revisão e envio.** Execute `/gsd-review` para
   obter revisão por pares adversarial do plano por IAs independentes (detecta
   pontos cegos modelo a modelo), depois `/gsd-ship` para abrir o PR com um
   corpo rico montado a partir dos artefatos de planejamento. Ambos os
   controles exigem uma decisão humana antes de qualquer coisa chegar ao
   repositório remoto.
7. **Capture trabalho subsequente explicitamente.** Use `/gsd-capture` para
   notas inline, `/gsd-capture --seed` para ideias que valem uma fase futura,
   ou `/gsd-new-milestone` para um grupo coerente de trabalhos subsequentes.
   Criar uma issue no rastreador a partir de um trabalho subsequente
   descoberto requer confirmação explícita do usuário — o GSD não publica em
   rastreadores remotos automaticamente.

Quando o PR é mesclado, o loop se fecha. Palavras-chave de fechamento
automático no corpo do PR (`Closes #NNN` / `Fixes #NNN`) fecham a issue do
rastreador no momento do merge.

## Limites de segurança

O loop é seguro porque quatro invariantes se mantêm por construção:

- **Worktrees isoladas.** Cada issue roda em uma worktree de
  `/gsd-workspace --new`, para que trabalho parcial, planos abandonados e
  commits exploratórios nunca toquem o `main`. `gsd-local-patches/` é a
  superfície de recuperação se edições manuais de uma worktree precisarem
  voltar após uma atualização.
- **Revisão humana explícita.** `/gsd-review` e `/gsd-ship` ambos param para
  aprovação humana. Não há auto-merge e nenhum caminho de auto-PR a partir
  da execução. Se você quiser remover o controle humano para um repositório
  específico, essa é a sua decisão de política de proteção de branch /
  fila de merge — não algo que o GSD decide por você.
- **Nenhuma publicação automática.** O GSD nunca abre, comenta ou fecha uma
  issue do rastreador sem um comando explicitamente iniciado pelo usuário.
  A captura de trabalho subsequente padrão são artefatos locais (notas,
  seeds, marcos); empurrar de volta para o rastreador é uma etapa manual
  separada.
- **Verificação antes do envio.** O `UAT.md` do `/gsd-verify-work` deve
  registrar evidências antes que `/gsd-ship` seja executado. A disciplina
  recomendada é tratar `verification_failed` como um bloqueador mesmo quando
  a implementação parece correta — a falha geralmente revela um critério de
  aceitação perdido, não um teste instável.

Se qualquer um desses invariantes for contornado (ex: executar `claude`
diretamente na worktree, pular `/gsd-verify-work`, ou criar issues via a API
do rastreador sem confirmação do usuário), as garantias deste guia não se
aplicam.

## Não-objetivos

Este guia deliberadamente **não** propõe nada do seguinte. Eles estão listados
aqui para que futuros contribuidores não voltem a discuti-los em revisão de
código:

- **Sem venda ou cópia do código Symphony.** O GSD reutiliza seus próprios
  primitivos. O mapeamento acima é conceitual; nenhum código derivado do
  Symphony está incluído neste repositório.
- **Sem daemon de longa execução.** O GSD não faz polling no GitHub ou Linear.
  Os fluxos de trabalho de manager e autonomous lidam com concorrência através
  da semântica de agente em segundo plano, não de um daemon.
- **Sem dependência obrigatória de rastreador.** O loop funciona sem qualquer
  integração com rastreador. A etapa "issue do rastreador" é uma *entrada
  humana* — a URL vai para `CONTEXT.md`. O GSD não tem opinião sobre qual
  rastreador você usa, ou se você usa algum.
- **Sem contorno dos controles de verificação, revisão ou decisão humana.**
  Mesmo ao executar `/gsd-autonomous`, os controles de verificação e revisão
  ainda disparam. O rótulo "autonomous" se refere à progressão de fase a fase,
  não ao pulo da aprovação humana.
- **Sem expansão da superfície padrão de habilidades / comandos.** Cada
  comando referenciado neste guia já existe. Este guia é uma superfície de
  documentação, não uma superfície de funcionalidades.

## Possível trabalho subsequente

Se a experiência dos mantenedores com esse loop justificar, uma melhoria
aprovada poderá adicionar posteriormente uma ponte *mínima* com rastreadores:

- Importar uma issue do GitHub ou Linear para um workspace / fase do GSD.
- Exportar evidências de `UAT.md` como comentário na issue de origem.
- Gerar issues de trabalho subsequente no rastreador a partir da saída de
  `/gsd-capture --seed`.

Cada uma dessas seria sua própria proposta de melhoria, pois cada uma adiciona
superfície de integração e carga de manutenção contínua. Elas estão fora do
escopo deste guia.

## Relacionados

- [O loop de fase](explanation/the-phase-loop.md) — como discuss → plan → execute → verify → ship se encaixam como um ciclo repetitivo.
- [Como trabalhar com workspaces](how-to/work-in-parallel-with-workstreams.md) — guia passo a passo para criar e gerenciar worktrees paralelas.
- [Índice de documentação](README.md) — sumário completo da documentação do GSD Core.
- [docs/USER-GUIDE.md](./USER-GUIDE.md) — guias orientados a tarefas dos comandos individuais referenciados acima.
- [docs/COMMANDS.md](COMMANDS.md) — referência completa dos comandos `/gsd-*`.
- [docs/FEATURES.md](FEATURES.md) — matriz de capacidades por funcionalidade (workspaces, manager, autonomous, verify, review, ship).
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — ciclo de vida dos artefatos de fase e mecânica do `STATE.md`.
