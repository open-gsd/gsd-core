# Seu primeiro projeto

Neste tutorial você instalará o GSD Core e construirá um pequeno aplicativo de linha de comando para gerenciar tarefas do zero — uma fase, um PR, o ciclo completo. Ao final, você terá executado cada comando do ciclo de fase principal pelo menos uma vez e terá visto os artefatos de planejamento que cada comando produz.

---

## O que você vai construir

Um CLI em Node.js que permite adicionar, listar e concluir itens de tarefas armazenados em um arquivo JSON local. É pequeno o suficiente para terminar em uma sessão e não utiliza nada além da biblioteca padrão do Node.js, portanto não há nada incomum para instalar.

---

## Pré-requisitos

- **Node.js 18 ou superior** — `node --version` deve exibir `v18.x.x` ou maior.
- **Claude Code** — aberto no diretório do projeto que você deseja utilizar.
- Uma conexão com a internet para a instalação inicial.

Nenhuma outra ferramenta é necessária. O próprio GSD Core é instalado no próximo passo.

---

## Passo 1 — Instalar o GSD Core

Abra um terminal no diretório do seu projeto e execute:

```bash
npx @opengsd/gsd-core@latest
```

O instalador pergunta qual ambiente de execução de IA você está usando e se deseja instalar globalmente ou no projeto atual. Escolha **Claude Code** e **local** (apenas este projeto) por enquanto.

Você verá uma saída como:

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

Observe que um diretório `.claude/` agora existe no seu projeto. É onde os comandos e agentes do GSD Core residem.

> Por que local vs global? Uma instalação local mantém a versão das skills fixada neste projeto. Consulte [Instalar no seu ambiente de execução](../how-to/install-on-your-runtime.md) quando quiser instalar globalmente.

---

## Passo 2 — Iniciar o Claude Code com permissões

O GSD Core spawna sub-agentes que leem e escrevem arquivos. Inicie o Claude Code com o sinalizador de permissões para que ele não pause para perguntar sobre cada operação de arquivo:

```bash
claude --dangerously-skip-permissions
```

Você chegará ao prompt do Claude Code no diretório do seu projeto.

---

## Passo 3 — Criar o projeto

Digite este comando slash no prompt do Claude Code:

```text
/gsd-new-project
```

O GSD Core abrirá uma conversa. Ele faz uma pergunta primeiro:

```text
What do you want to build?
```

Digite algo como:

```text
A Node.js CLI tool for managing to-do items. Users run `todo add "buy milk"`,
`todo list`, and `todo done 1`. Items are saved to a local todos.json file.
No external dependencies — Node built-ins only.
```

O GSD Core faz uma série de perguntas de esclarecimento. Responda naturalmente. Ele está aprendendo o que é importante para você antes de escrever qualquer plano.

Após as perguntas, ele oferece a opção de realizar pesquisa de domínio. Para um projeto deste tamanho você pode pular a pesquisa — escolha **Skip research** quando solicitado.

O GSD Core então pede que você escolha as configurações de fluxo de trabalho (modo, granularidade, agentes de pesquisa). Escolha os padrões recomendados para cada um. Eles são gravados em `.planning/config.json`.

Por fim, um sub-agente de roadmap é executado (você verá o aviso "Spawning roadmapper…" — isso é normal e leva cerca de um minuto). Quando ele retornar, o GSD Core apresentará um roadmap proposto. Para um projeto de uma única fase, ele terá uma aparência semelhante a:

```text
Proposed Roadmap

1 phase | 4 requirements mapped | All v1 requirements covered ✓

| # | Phase              | Goal                                    | Requirements      |
|---|--------------------|-----------------------------------------|-------------------|
| 1 | Core CLI           | add / list / done commands, todos.json  | CLI-01 … CLI-04   |
```

Digite **Approve** para aceitar o roadmap.

**O que é criado em `.planning/`:**

```text
.planning/
  PROJECT.md          ← descrição e requisitos do seu projeto
  REQUIREMENTS.md     ← REQ-IDs para cada capacidade v1
  ROADMAP.md          ← Fase 1, status: pending
  STATE.md            ← memória de sessão, posição atual
  config.json         ← configurações de fluxo de trabalho
```

Abra `.planning/ROADMAP.md` agora e leia. Observe que a Fase 1 tem uma Meta, uma lista de Requisitos que deve satisfazer e Critérios de Sucesso — estes são os comportamentos observáveis que a execução deve entregar.

---

## Passo 4 — Limpar o contexto e discutir a Fase 1

O GSD Core é projetado em torno de contextos frescos. Limpe a janela de sessão principal antes de cada fase:

```text
/clear
```

Em seguida, inicie a discussão para a Fase 1:

```text
/gsd-discuss-phase 1
```

O GSD Core lê a meta da fase e pergunta sobre suas preferências de implementação. Estas são as decisões que moldam *como* ele constrói, não apenas *o que* ele constrói. Exemplo de troca:

```text
> How should done items be stored — mark them in place or move them?
  Mark them in place with a "done" flag.

> Should `todo list` show completed items by default?
  No, hide them unless --all is passed.

> Error format when todos.json doesn't exist yet?
  Create it silently on first add.
```

Quando a discussão encerra, o GSD Core escreve:

```text
.planning/phases/01-core-cli/CONTEXT.md
```

Abra esse arquivo. Você verá uma seção `## Implementation Decisions` capturando exatamente o que você disse. O planejador lê este arquivo — portanto, as decisões que você tomou aqui fluirão para cada plano de tarefa.

---

## Passo 5 — Planejar a Fase 1

```text
/gsd-plan-phase 1
```

Quatro sub-agentes de pesquisa se expandem em paralelo (você verá o aviso "Spawning 4 researchers…"). Eles levam de 1 a 5 minutos. Não interrompa.

Quando retornarem, um planejador lê o CONTEXT.md mais os resultados da pesquisa e cria planos de tarefa atômicos. Um verificador de planos então verifica se cada plano atinge a meta da fase antes de salvar.

**O que é criado:**

```text
.planning/phases/01-core-cli/
  RESEARCH.md         ← descobertas de domínio
  01-01-PLAN.md       ← Tarefa: criar helpers de leitura/escrita de todos.json
  01-02-PLAN.md       ← Tarefa: implementar os comandos add / list / done
```

Abra `01-01-PLAN.md`. Você verá um bloco `<task>` com um nome, os arquivos que toca, as etapas de ação, um comando de verificação e uma condição de conclusão. Observe a tag `<verify>` — o executor do GSD Core executará esse comando após escrever o código.

---

## Passo 6 — Executar a Fase 1

```text
/gsd-execute-phase 1
```

O GSD Core agrupa os planos em ondas (planos independentes são executados em paralelo), spawna um executor fresco com 200k de contexto por plano e confirma cada tarefa atomicamente.

Você verá algo como:

```text
Wave 1 (parallel):
  [Executor A] → 01-01-PLAN.md (read/write helpers)   ✓ committed
  [Executor B] → 01-02-PLAN.md (CLI commands)          ✓ committed

[Verifier] Checking codebase against phase goals...
  CLI-01 todo add   ✓
  CLI-02 todo list  ✓
  CLI-03 todo done  ✓
  CLI-04 --all flag ✓
  Status: PASS
```

**O que é criado:**

```text
.planning/phases/01-core-cli/
  01-01-SUMMARY.md    ← o que o Executor A construiu e confirmou
  01-02-SUMMARY.md    ← o que o Executor B construiu e confirmou
  VERIFICATION.md     ← cobertura de REQ: PASS
```

Execute seu CLI agora:

```bash
node todo.js add "buy milk"
node todo.js add "write tests"
node todo.js list
node todo.js done 1
node todo.js list
```

Você deve ver os itens aparecerem e o item 1 desaparecer da lista padrão após marcá-lo como concluído. Esse é o seu primeiro resultado visível entregue pelo GSD Core.

---

## Passo 7 — Verificar o trabalho

```text
/gsd-verify-work 1
```

O GSD Core extrai os critérios de sucesso da fase e os percorre um a um:

```text
[1/3] Can you run `node todo.js add "buy milk"` without errors?
> yes

[2/3] Does `node todo.js list` show only incomplete items by default?
> yes

[3/3] Does `node todo.js done 1` mark item 1 complete and hide it from the default list?
> yes

All 3 checks passed. Phase 1 verified.
```

Se alguma verificação falhar, o GSD Core diagnostica a causa raiz e cria um plano de correção. Execute `/gsd-execute-phase 1` novamente para aplicá-lo e depois re-execute `/gsd-verify-work 1`.

**O que é criado:**

```text
.planning/phases/01-core-cli/UAT.md   ← todas as verificações e seus resultados
```

---

## Passo 8 — Publicar

```text
/gsd-ship 1
```

O GSD Core cria um pull request com um corpo gerado automaticamente. O corpo do PR sempre inclui: Resumo, Alterações, Requisitos Atendidos, Verificação e Decisões Principais.

Você verá:

```text
Pull request created: https://github.com/your-org/your-repo/pull/1

Title: feat(phase-1): core CLI — add / list / done commands
```

Esse é o ciclo completo — da ideia ao PR mesclado — para uma fase.

---

## O que você aprendeu

- Como instalar o GSD Core com `npx @opengsd/gsd-core@latest`.
- Como `/gsd-new-project` transforma uma conversa em um roadmap respaldado por artefatos em `.planning/`.
- Como `/gsd-discuss-phase` captura decisões de implementação antes de qualquer planejamento acontecer.
- Como `/gsd-plan-phase` spawna pesquisadores em paralelo e produz planos de tarefa atômicos.
- Como `/gsd-execute-phase` executa esses planos em ondas paralelas e confirma cada tarefa.
- Como `/gsd-verify-work` percorre os critérios de sucesso e gera planos de correção quando necessário.
- Como `/gsd-ship` transforma uma fase verificada em um pull request.

Para um projeto de múltiplas fases, repita os Passos 4–8 para cada fase e depois execute `/gsd-progress --next` para deixar o GSD Core detectar o próximo passo automaticamente.

---

## Relacionados

- [O ciclo de fase](../explanation/the-phase-loop.md) — por que o ciclo tem esse formato
- [Guias práticos](../README.md#how-to-guides) — receitas focadas em tarefas para situações específicas
- [Integrando uma base de código existente](onboarding-an-existing-codebase.md) — traga o GSD Core para um repositório já existente
