# Como trabalhar em múltiplas áreas em paralelo com workstreams

**Objetivo:** Executar trabalho simultâneo em diferentes áreas de um milestone — API backend, painel frontend, infraestrutura ou qualquer outra preocupação — sem que o estado de planejamento de uma área vaze para outra.

**Pré-requisitos:** Um projeto GSD Core ativo (`.planning/ROADMAP.md` existe). Se não existir, execute `/gsd-new-project` primeiro.

---

## O que são workstreams

Um workstream é um contexto de planejamento isolado dentro de um único repositório de código. Cada workstream possui seu próprio subárvore `.planning/workstreams/<name>/` contendo diretórios independentes `STATE.md`, `ROADMAP.md`, `REQUIREMENTS.md` e `phases/`. O próprio repositório — código-fonte, histórico git e branches — é compartilhado entre todos os workstreams.

```
.planning/
├── PROJECT.md          ← compartilhado
├── config.json         ← compartilhado
├── codebase/           ← compartilhado
└── workstreams/
    ├── backend-api/
    │   ├── STATE.md
    │   ├── ROADMAP.md
    │   ├── REQUIREMENTS.md
    │   └── phases/
    └── frontend-dash/
        ├── STATE.md
        ├── ROADMAP.md
        ├── REQUIREMENTS.md
        └── phases/
```

Quando um workstream está ativo, todos os comandos GSD — `/gsd-progress`, `/gsd-discuss-phase`, `/gsd-plan-phase`, `/gsd-execute-phase` — leem e escrevem no diretório desse workstream. Alternar workstreams redireciona todos esses comandos para uma subárvore diferente sem tocar na árvore de código-fonte.

---

## Criar um workstream

```bash
/gsd-workstreams create backend-api
```

O GSD cria o diretório do workstream em `.planning/workstreams/backend-api/` e o inicializa com um `STATE.md` e `ROADMAP.md` esqueleto. O workstream não é ativado automaticamente — você precisa alternar para ele explicitamente.

---

## Listar workstreams

```bash
/gsd-workstreams list
```

Exibe todos os workstreams e qual está atualmente ativo na sua sessão.

---

## Alternar para um workstream

```bash
/gsd-workstreams switch backend-api
```

A partir deste ponto, todos os comandos de fluxo de trabalho GSD operam no contexto `backend-api`. A alternância é vinculada à sessão: quando múltiplos terminais do Claude Code estão abertos no mesmo repositório, cada sessão pode ter um workstream ativo diferente sem interferir nos demais.

Após alternar, execute o fluxo normal de fases:

```bash
/gsd-discuss-phase 1
/gsd-plan-phase 1
/gsd-execute-phase 1
/gsd-verify-work 1
```

Para trabalhar em outra área, alterne workstreams em um segundo terminal:

```bash
/gsd-workstreams switch frontend-dash
/gsd-discuss-phase 1
/gsd-plan-phase 1
```

---

## Verificar o progresso em todos os workstreams

```bash
/gsd-workstreams progress
```

Exibe um resumo entre workstreams — status das fases, posição atual e trabalho pendente para cada workstream — sem exigir que você alterne entre eles.

Para status detalhado de um único workstream:

```bash
/gsd-workstreams status backend-api
```

---

## Retomar o trabalho em um workstream

Após uma redefinição de contexto ou uma nova sessão, restaure sua posição:

```bash
/gsd-workstreams resume backend-api
```

Isso ativa o workstream e restaura sua última posição conhecida dentro dele, equivalente a alternar e então executar `/gsd-resume-work`.

---

## Arquivar um workstream concluído

Quando o trabalho do milestone de um workstream estiver concluído:

```bash
/gsd-workstreams complete backend-api
```

O GSD marca o workstream como arquivado e o remove da listagem ativa. Os artefatos de planejamento são preservados em `.planning/workstreams/backend-api/` para fins de auditoria.

---

## Executar um único comando em um workstream sem alternar

Se você precisar executar um comando em um workstream específico sem alterar o contexto ativo da sua sessão, use a flag `--ws`:

```bash
/gsd-progress --ws frontend-dash
/gsd-plan-phase 2 --ws backend-api
```

`--ws` tem a maior prioridade na ordem de resolução e não altera o ponteiro vinculado à sessão.

---

## Quando usar workstreams em vez de workspaces

Escolha workstreams quando:

- Todo o trabalho está no **mesmo repositório** e compartilha o mesmo histórico git
- Você quer planejar ou discutir diferentes áreas de preocupação (API, UI, infra) **de forma simultânea** sem que o `STATE.md` de um workstream sobrescreva o de outro
- Você não precisa de um branch separado por workstream no momento da criação (embora possa criar branches normalmente dentro da execução de cada workstream)
- O custo de criação de worktrees git completos não é justificado pelo nível de isolamento necessário

Escolha [workspaces](isolate-work-with-workspaces.md) quando:

- Você está trabalhando em **múltiplos repositórios** (por exemplo, `hr-ui` e `ZeymoAPI`)
- Você precisa do isolamento de uma **worktree ou clone git separado** por funcionalidade — branches, arquivos de lock e artefatos de build totalmente independentes
- Você quer executar `/gsd-new-project` independentemente em cada workspace com uma raiz `.planning/` completamente separada, não um subdiretório do `.planning/` do repositório principal

---

## Relacionados

- [Isolar trabalho com workspaces](isolate-work-with-workspaces.md)
- [O ciclo de fases](../explanation/the-phase-loop.md)
- [Comandos](../COMMANDS.md)
- [Índice de documentação](../README.md)
