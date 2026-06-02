# Como isolar trabalho com workspaces

**Objetivo:** Criar um ambiente GSD completamente isolado — worktree git separado, raiz `.planning/` independente e, opcionalmente, múltiplos repositórios — para branches de funcionalidades ou trabalho em múltiplos repositórios.

**Pré-requisitos:** O `git` está instalado e o repositório oferece suporte a worktrees. Para workspaces com múltiplos repositórios, os repositórios de destino existem em sua máquina local ou são acessíveis por caminho.

---

## O que são workspaces

Um workspace é um ambiente autocontido que combina um ou mais worktrees git (ou clones) com seu próprio diretório raiz `.planning/`. Cada workspace possui:

- Seu próprio diretório `.planning/` que é **completamente independente** do `.planning/` do repositório de origem — não é um subdiretório dele
- Seu próprio manifesto `WORKSPACE.md` que rastreia os repositórios membros
- Worktrees git (padrão) ou clones completos dos repositórios especificados, com checkout em uma branch dedicada (padrão: `workspace/<nome>`)

Por padrão, os workspaces ficam em `~/gsd-workspaces/<nome>/`.

```
~/gsd-workspaces/
└── feature-b/
    ├── WORKSPACE.md        ← manifesto
    ├── .planning/          ← estado GSD totalmente independente
    │   ├── PROJECT.md
    │   ├── ROADMAP.md
    │   └── ...
    ├── hr-ui/              ← worktree ou clone do repositório hr-ui
    └── ZeymoAPI/           ← worktree ou clone do repositório ZeymoAPI
```

Como o `.planning/` do workspace é separado dos repositórios de origem, não há sobreposição ou conflito com o estado de planejamento existente nos próprios repositórios de origem.

---

## Criar um workspace para múltiplos repositórios

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI
```

O GSD cria worktrees de `hr-ui` e `ZeymoAPI` dentro de `~/gsd-workspaces/feature-b/`, faz checkout de uma branch `workspace/feature-b` em cada um, grava o `WORKSPACE.md` e cria um diretório `.planning/` vazio pronto para `/gsd-new-project`.

Para personalizar o local:

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI --path /projects/feature-b
```

---

## Criar um workspace para o repositório atual

Quando você deseja isolamento por branch de funcionalidade em um único repositório — branch independente, `.planning/` independente, sem vazamento de estado da branch principal:

```bash
/gsd-workspace --new --name payments-rework --repos .
```

O `.` instrui o GSD a criar um worktree do repositório atual. O worktree recebe checkout em `workspace/payments-rework`.

Para forçar um clone completo em vez de um worktree:

```bash
/gsd-workspace --new --name payments-rework --repos . --strategy clone
```

---

## Especificar uma branch explicitamente

```bash
/gsd-workspace --new --name payments-rework --repos . --branch feature/payments-v2
```

O flag `--branch` define o nome da branch para todos os repositórios do workspace. O padrão é `workspace/<nome>`.

---

## Ignorar perguntas interativas

```bash
/gsd-workspace --new --name payments-rework --repos . --auto
```

O GSD aceita todos os padrões sem solicitar confirmação.

---

## Inicializar o GSD dentro do workspace

Após criar um workspace, acesse-o e inicialize um projeto GSD:

```bash
cd ~/gsd-workspaces/feature-b
/gsd-new-project
```

O diretório `.planning/` dentro do workspace é a raiz para todos os comandos GSD subsequentes executados a partir desse diretório. Ele é completamente separado de qualquer `.planning/` existente nos repositórios de origem.

---

## Listar workspaces

```bash
/gsd-workspace --list
```

Exibe todos os workspaces GSD ativos e seus status.

---

## Remover um workspace

```bash
/gsd-workspace --remove feature-b
```

O GSD remove os worktrees git e limpa o diretório do workspace. Isso não exclui as branches do remote de origem — apenas os worktrees locais e o diretório do workspace.

---

## Quando usar workspaces em vez de workstreams

Escolha workspaces quando:

- Você está trabalhando em **múltiplos repositórios** que precisam ser coordenados sob um único projeto GSD (por exemplo, um repositório de API e um repositório de UI que fazem entregas juntos)
- Você precisa de um **worktree git separado** com sua própria branch, arquivos de lock e artefatos de build por funcionalidade — para que builds e instalações de dependências em um ambiente não afetem outro
- Você deseja uma **raiz `.planning/` completamente independente** em vez de um subdiretório do `.planning/` do repositório principal
- Você está seguindo um fluxo de trabalho orientado a issues em que cada issue do rastreador é mapeada para um workspace (consulte [Conduzir o GSD a partir de uma issue do rastreador](drive-gsd-from-a-tracker-issue.md))

Escolha [workstreams](work-in-parallel-with-workstreams.md) quando:

- Todo o trabalho está em **um único repositório** e compartilha o mesmo histórico git
- Você deseja executar `/gsd-plan-phase` ou `/gsd-discuss-phase` em diferentes áreas de interesse simultaneamente — API, UI, infra — sem vazamento de contexto entre os arquivos `STATE.md`
- Você não precisa de um worktree separado por área de interesse; alternar o contexto de planejamento é suficiente

---

## Relacionados

- [Trabalhar em paralelo com workstreams](work-in-parallel-with-workstreams.md)
- [Conduzir o GSD a partir de uma issue do rastreador](drive-gsd-from-a-tracker-issue.md)
- [Comandos](../COMMANDS.md)
- [Índice de documentação](../README.md)
