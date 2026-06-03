# Referência de Ferramentas CLI do GSD

> Referência para o CLI `gsd-tools` (`get-shit-done/bin/gsd-tools.cjs`). Para comandos slash e fluxos de usuário, consulte a [Referência de Comandos](COMMANDS.md). Voltar ao [índice de documentação](README.md).

---

## Visão Geral

`gsd-tools.cjs` centraliza a análise de configuração, resolução de modelos, busca de fases, commits git, verificação de resumos, gerenciamento de estado e operações de templates em comandos, fluxos de trabalho e agentes do GSD.


|                    |                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Caminho instalado**   | `get-shit-done/bin/gsd-tools.cjs`                                                                                                                                                                      |
| **Implementação** | 20 módulos de domínio em `get-shit-done/bin/lib/` (o diretório é autoritativo)                                                                                                                        |
| **Status**         | Principal superfície de comandos em tempo de execução para orquestração, fluxos de trabalho e automação. |


**Uso (CJS):**

```bash
node gsd-tools.cjs <command> [args] [--raw] [--cwd <path>]
```

**Flags globais (CJS):**


| Flag           | Descrição                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `--raw`        | Saída legível por máquina (JSON ou texto simples, sem formatação)                  |
| `--cwd <path>` | Substitui o diretório de trabalho (para subagentes em sandbox)                         |
| `--ws <name>`  | Contexto de fluxo de trabalho para caminhos `.planning/workstreams/<name>` |


---

## Comandos de Estado

Gerencia `.planning/STATE.md` — a memória viva do projeto.

```bash
# Carrega configuração completa do projeto + estado como JSON
node gsd-tools.cjs state load

# Exibe o frontmatter do STATE.md como JSON
node gsd-tools.cjs state json

# Atualiza um único campo
node gsd-tools.cjs state update <field> <value>

# Obtém o conteúdo do STATE.md ou uma seção específica
node gsd-tools.cjs state get [section]

# Atualiza múltiplos campos em lote
node gsd-tools.cjs state patch --field1 val1 --field2 val2

# Incrementa o contador de planos
node gsd-tools.cjs state advance-plan

# Registra métricas de execução
node gsd-tools.cjs state record-metric --phase N --plan M --duration Xmin [--tasks N] [--files N]

# Recalcula a barra de progresso
node gsd-tools.cjs state update-progress

# Adiciona uma decisão
node gsd-tools.cjs state add-decision --summary "..." [--phase N] [--rationale "..."]
# Ou a partir de arquivos:
node gsd-tools.cjs state add-decision --summary-file path [--rationale-file path]

# Adiciona/resolve bloqueadores
node gsd-tools.cjs state add-blocker --text "..."
node gsd-tools.cjs state resolve-blocker --text "..."

# Registra continuidade da sessão
node gsd-tools.cjs state record-session --stopped-at "..." [--resume-file path]

# Início de fase — atualiza Status/Última atividade do STATE.md para uma nova fase
node gsd-tools.cjs state begin-phase --phase N --name SLUG --plans COUNT

# Sinalização de bloqueador detectável por agentes (usado por discuss-phase / fluxos de UI)
node gsd-tools.cjs state signal-waiting --type TYPE --question "..." --options "A|B" --phase P
node gsd-tools.cjs state signal-resume
```

### Snapshot de Estado

Análise estruturada do STATE.md completo:

```bash
node gsd-tools.cjs state-snapshot
```

Retorna JSON com: posição atual, fase, plano, status, decisões, bloqueadores, métricas, última atividade.

---

## Comandos de Fase

Gerencia fases — diretórios, numeração e sincronização com o roadmap.

```bash
# Localiza diretório de fase pelo número
node gsd-tools.cjs find-phase <phase>

# Calcula o próximo número de fase decimal para inserções
node gsd-tools.cjs phase next-decimal <phase>

# Adiciona nova fase ao roadmap + cria diretório
node gsd-tools.cjs phase add <description>

# Insere fase decimal após a existente
node gsd-tools.cjs phase insert <after> <description>

# Remove fase, renumera as subsequentes
node gsd-tools.cjs phase remove <phase> [--force]

# Marca a fase como concluída, atualiza estado + roadmap
node gsd-tools.cjs phase complete <phase>

# Indexa planos com ondas e status
node gsd-tools.cjs phase-plan-index <phase>

# Lista fases com filtragem
node gsd-tools.cjs phases list [--type planned|executed|all] [--phase N] [--include-archived]
```

---

## Comandos de Roadmap

Analisa e atualiza o `ROADMAP.md`.

```bash
# Extrai a seção de fase do ROADMAP.md
node gsd-tools.cjs roadmap get-phase <phase>

# Análise completa do roadmap com status em disco
node gsd-tools.cjs roadmap analyze

# Atualiza linha da tabela de progresso a partir do disco
node gsd-tools.cjs roadmap update-plan-progress <N>
```

---

## Comandos de Configuração

Lê e grava em `.planning/config.json`.

```bash
# Inicializa config.json com valores padrão
node gsd-tools.cjs config-ensure-section

# Define um valor de configuração (notação de ponto)
node gsd-tools.cjs config-set <key> <value>

# Obtém um valor de configuração
node gsd-tools.cjs config-get <key>

# Define o perfil de modelo
node gsd-tools.cjs config-set-model-profile <profile>
```

---

## Resolução de Modelos

```bash
# Obtém o modelo para um agente com base no perfil atual
node gsd-tools.cjs resolve-model <agent-name>
# A saída bruta retorna o ID/tier do modelo selecionado.
# A saída JSON também inclui o perfil e, quando o runtime ativo suporta,
# reasoning_effort.
```

Nomes de agentes: `gsd-planner`, `gsd-executor`, `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-roadmapper`, `gsd-debugger`, `gsd-codebase-mapper`, `gsd-nyquist-auditor`

---

## Comandos de Verificação

Valida planos, fases, referências e commits.

```bash
# Verifica arquivo SUMMARY.md
node gsd-tools.cjs verify-summary <path> [--check-count N]

# Verifica estrutura + tarefas do PLAN.md
node gsd-tools.cjs verify plan-structure <file>

# Verifica se todos os planos têm resumos
node gsd-tools.cjs verify phase-completeness <phase>

# Verifica se @-refs + caminhos resolvem
node gsd-tools.cjs verify references <file>

# Verifica hashes de commit em lote
node gsd-tools.cjs verify commits <hash1> [hash2] ...

# Verifica must_haves.artifacts
node gsd-tools.cjs verify artifacts <plan-file>

# Verifica must_haves.key_links
node gsd-tools.cjs verify key-links <plan-file>
```

---

## Comandos de Validação

Verifica a integridade do projeto.

```bash
# Verifica numeração de fases, sincronização disco/roadmap
node gsd-tools.cjs validate consistency

# Verifica integridade de .planning/, com opção de reparo
node gsd-tools.cjs validate health [--repair]

# Verifica utilização da janela de contexto para linha de status / chamadores de hook (v1.40.0)
node gsd-tools.cjs validate context

# Utilização de contexto como superfície JSON tipada (#455)
node gsd-tools.cjs validate context --json
```

`validate context` emite um envelope estruturado com `utilization`, `status`
(`ok` / `warn` / `critical` nos limites de 60% / 70%), e uma
string `suggestion`. Os mesmos dados sustentam `/gsd-health --context`.
Passe `--json` para receber o IR tipado diretamente (útil em scripts e asserções de teste).

---

## Comandos de Template

Seleção e preenchimento de templates.

```bash
# Seleciona o template de resumo com base na granularidade
node gsd-tools.cjs template select <type>

# Preenche o template com variáveis
node gsd-tools.cjs template fill <type> --phase N [--plan M] [--name "..."] [--type execute|tdd] [--wave N] [--fields '{json}']
```

Tipos de template para `fill`: `summary`, `plan`, `verification`

---

## Comandos de Frontmatter

Operações CRUD de frontmatter YAML em qualquer arquivo Markdown.

```bash
# Extrai frontmatter como JSON
node gsd-tools.cjs frontmatter get <file> [--field key]

# Atualiza único campo
node gsd-tools.cjs frontmatter set <file> --field key --value jsonVal

# Mescla JSON no frontmatter
node gsd-tools.cjs frontmatter merge <file> --data '{json}'

# Valida campos obrigatórios
node gsd-tools.cjs frontmatter validate <file> --schema plan|summary|verification
```

---

## Comandos de Scaffold

Cria arquivos e diretórios pré-estruturados.

```bash
# Cria template CONTEXT.md
node gsd-tools.cjs scaffold context --phase N

# Cria template UAT.md
node gsd-tools.cjs scaffold uat --phase N

# Cria template VERIFICATION.md
node gsd-tools.cjs scaffold verification --phase N

# Cria diretório de fase
node gsd-tools.cjs scaffold phase-dir --phase N --name "phase name"
```

---

## Comandos Init (Carregamento de Contexto Composto)

Carrega todo o contexto necessário para um fluxo de trabalho específico em uma única chamada. Retorna JSON com informações do projeto, configuração, estado e dados específicos do fluxo de trabalho.

```bash
node gsd-tools.cjs init execute-phase <phase>
node gsd-tools.cjs init plan-phase <phase>
node gsd-tools.cjs init new-project
node gsd-tools.cjs init new-milestone
node gsd-tools.cjs init quick <description>
node gsd-tools.cjs init resume
node gsd-tools.cjs init verify-work <phase>
node gsd-tools.cjs init phase-op <phase>
node gsd-tools.cjs init todos [area]
node gsd-tools.cjs init milestone-op
node gsd-tools.cjs init map-codebase
node gsd-tools.cjs init progress

# Init com escopo de fluxo de trabalho (flag `--ws`)
node gsd-tools.cjs init execute-phase <phase> --ws <name>
node gsd-tools.cjs init plan-phase <phase> --ws <name>
```

**Tratamento de payloads grandes:** Quando a saída excede ~50KB, o CLI grava em um arquivo temporário e retorna `@file:/tmp/gsd-init-XXXXX.json`. Os fluxos de trabalho verificam o prefixo `@file:` e leem do disco:

```bash
INIT=$(node gsd-tools.cjs init execute-phase "1")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

---

## Comandos de Milestone

```bash
# Arquiva milestone
node gsd-tools.cjs milestone complete <version> [--name <name>] [--archive-phases]

# Marca requisitos como concluídos
node gsd-tools.cjs requirements mark-complete <ids>
# Aceita: REQ-01,REQ-02 ou REQ-01 REQ-02 ou [REQ-01, REQ-02]
```

---

## Habilidades de Agente

Emite o bloco de habilidades para um tipo de agente específico.

```bash
# Emite bloco XML bruto de habilidades (padrão — seguro para expansão de shell)
node gsd-tools.cjs agent-skills <agent-type>

# Emite superfície JSON tipada (#455) — { agent_type, block, skills_count }
node gsd-tools.cjs agent-skills <agent-type> --json
```

A flag `--json` retorna um objeto IR tipado adequado para consumo estruturado e asserções de teste, enquanto o padrão (sem flag) preserva a saída XML bruta que as expansões de shell de fluxo de trabalho necessitam.

---

## Manifesto de Habilidades

Pré-computa e armazena em cache a descoberta de habilidades para carregamento mais rápido de comandos.

```bash
# Gera manifesto de habilidades (grava em .claude/skill-manifest.json)
node gsd-tools.cjs skill-manifest

# Gera com caminho de saída personalizado
node gsd-tools.cjs skill-manifest --output <path>
```

Retorna mapeamento JSON de todas as habilidades GSD disponíveis com seus metadados (nome, descrição, caminho de arquivo, dicas de argumentos). Usado pelo instalador e hooks de início de sessão para evitar varreduras repetidas do sistema de arquivos.

---

## Comandos Utilitários

```bash
# Converte texto em slug seguro para URL
node gsd-tools.cjs generate-slug "Some Text Here"
# → some-text-here

# Obtém timestamp
node gsd-tools.cjs current-timestamp [full|date|filename]

# Conta e lista tarefas pendentes
node gsd-tools.cjs list-todos [area]

# Verifica existência de arquivo/diretório
node gsd-tools.cjs verify-path-exists <path>

# Agrega todos os dados de SUMMARY.md
node gsd-tools.cjs history-digest

# Extrai dados estruturados de SUMMARY.md
node gsd-tools.cjs summary-extract <path> [--fields field1,field2]

# Estatísticas do projeto
node gsd-tools.cjs stats [json|table]

# Renderização de progresso (legível por humanos)
node gsd-tools.cjs progress [json|table|bar]

# Progresso como superfície JSON tipada (#455)
node gsd-tools.cjs progress --json

# Conclui uma tarefa
node gsd-tools.cjs todo complete <filename>

# Auditoria UAT — verifica todas as fases em busca de itens não resolvidos
node gsd-tools.cjs audit-uat

# Fila de auditoria entre artefatos — verifica `.planning/` em busca de itens de auditoria não resolvidos
node gsd-tools.cjs audit-open [--json]

# Migração reversa de um projeto GSD-2 para a estrutura atual (suporta `/gsd-import --from-gsd2`)
node gsd-tools.cjs from-gsd2 [--path <dir>] [--force] [--dry-run]

# Commit git com verificações de configuração
node gsd-tools.cjs commit <message> [--files f1 f2] [--amend] [--no-verify] [--respect-staged]
```

> `--no-verify`: Ignora hooks de pré-commit. Usado por agentes executores paralelos durante a execução baseada em ondas para evitar contenção de bloqueio de build (ex.: conflitos de cargo lock em projetos Rust). O orquestrador executa os hooks uma vez após cada onda ser concluída. Não use `--no-verify` durante a execução sequencial — deixe os hooks rodarem normalmente.
> `--files <paths>` **comportamento de staging**: por padrão, `--files` executa `git add -- <path>` para cada arquivo nomeado antes de commitar. Isso sobrescreve qualquer staging por hunk configurado via `git add -p`. Passe `--respect-staged` para ignorar o passo `git add` e commitar apenas o que já está no índice dentro do pathspec solicitado. Se nada estiver staged nesse escopo, o comando retorna `{ committed: false, reason: 'nothing staged' }` sem erro. O `-- <paths>` pathspec final no commit é aplicado em ambos os modos, portanto arquivos staged fora do escopo `--files` nunca são incluídos (invariante #3061).

```bash
# Busca na web (requer chave de API do Brave)
node gsd-tools.cjs websearch <query> [--limit N] [--freshness day|week|month]
```

---

## Graphify

Constrói, consulta e inspeciona o grafo de conhecimento do projeto em `.planning/graphs/`. Requer `graphify.enabled: true` em `config.json` (consulte a [Referência de Configuração](CONFIGURATION.md#graphify-settings)).

```bash
# Constrói ou reconstrói o grafo de conhecimento
node gsd-tools.cjs graphify build

# Pesquisa um termo no grafo
node gsd-tools.cjs graphify query <term>

# Exibe atualidade e estatísticas do grafo
node gsd-tools.cjs graphify status

# Exibe alterações desde a última construção
node gsd-tools.cjs graphify diff

# Grava um snapshot nomeado do grafo atual
node gsd-tools.cjs graphify snapshot [name]
```

Ponto de entrada para o usuário: `/gsd-graphify` (consulte a [Referência de Comandos](COMMANDS.md#gsd-graphify)).

---

## Arquitetura de Módulos

| Módulo | Arquivo | Exportações |
|--------|------|---------|
| Core | `lib/core.cjs` | `error()`, `output()`, `parseArgs()`, utilitários compartilhados, re-exportações de compatibilidade |
| State | `lib/state.cjs` | Todos os subcomandos `state`, `state-snapshot` |
| Phase | `lib/phase.cjs` | CRUD de fase, `find-phase`, `phase-plan-index`, `phases list` |
| Planning Workspace | `lib/planning-workspace.cjs` | Costura de planejamento: `planningDir`, `planningPaths`, roteamento de fluxo de trabalho ativo, `.planning/.lock` |
| Roadmap | `lib/roadmap.cjs` | Análise de roadmap, extração de fase, atualizações de progresso |
| Config | `lib/config.cjs` | Leitura/gravação de configuração, inicialização de seção |
| Verify | `lib/verify.cjs` | Todos os comandos de verificação e validação |
| Template | `lib/template.cjs` | Seleção de template e preenchimento de variáveis |
| Frontmatter | `lib/frontmatter.cjs` | CRUD de frontmatter YAML |
| Init | `lib/init.cjs` | Carregamento de contexto composto para todos os fluxos de trabalho |
| Milestone | `lib/milestone.cjs` | Arquivamento de milestone, marcação de requisitos |
| Commands | `lib/commands.cjs` | Diversos: slug, timestamp, todos, scaffold, stats, websearch |
| Model Profiles | `lib/model-profiles.cjs` | Tabela de resolução de perfis |
| UAT | `lib/uat.cjs` | Auditoria UAT/verificação entre fases |
| Profile Output | `lib/profile-output.cjs` | Formatação de perfil do desenvolvedor |
| Profile Pipeline | `lib/profile-pipeline.cjs` | Pipeline de análise de sessão |
| Graphify | `lib/graphify.cjs` | Construção/consulta/status/diff/snapshot do grafo de conhecimento (suporta `/gsd-graphify`) |
| Learnings | `lib/learnings.cjs` | Extrai aprendizados de artefatos de fases/SUMMARY (suporta `/gsd-extract-learnings`) |
| Audit | `lib/audit.cjs` | Manipuladores de fila de auditoria de fase/milestone; helper `audit-open` |
| GSD2 Import | `lib/gsd2-import.cjs` | Importador de migração reversa de projetos GSD-2 (suporta `/gsd-import --from-gsd2`) |
| Intel | `lib/intel.cjs` | Índice de inteligência de código consultável (suporta `/gsd-map-codebase --query`) |

---

## Roteamento CLI do Revisor

`review.models.<cli>` mapeia um sabor de revisor para um comando shell invocado pelo fluxo de trabalho de revisão de código. Defina via [`/gsd-config --integrations`](COMMANDS.md#gsd-config) ou diretamente:

```bash
node gsd-tools.cjs config-set review.models.codex    "codex exec --model gpt-5"
node gsd-tools.cjs config-set review.models.gemini   "gemini -m gemini-2.5-pro"
node gsd-tools.cjs config-set review.models.opencode "opencode run --model claude-sonnet-4"
node gsd-tools.cjs config-set review.models.claude   ""   # limpa — retorna ao modelo da sessão
```

Os slugs são validados contra `[a-zA-Z0-9_-]+`; slugs vazios ou contendo caminhos são rejeitados. Consulte [`docs/CONFIGURATION.md`](CONFIGURATION.md#code-review-cli-routing) para a referência completa do campo.

## Tratamento de Segredos

As chaves de API configuradas via `/gsd-settings` (`brave_search`, `firecrawl`, `exa_search`) são gravadas em texto simples em `.planning/config.json`, mas são mascaradas (`****<last-4>`) em toda saída de `config-set` / `config-get`, tabela de confirmação e prompt interativo. Consulte `get-shit-done/bin/lib/secrets.cjs` para a implementação do mascaramento. O próprio arquivo `config.json` é o limite de segurança — proteja-o com permissões do sistema de arquivos e mantenha-o fora do git (`.planning/` está no gitignore por padrão).

---

## Relacionados

- [Comandos](COMMANDS.md)
- [Configuração](CONFIGURATION.md)
- [Arquitetura](ARCHITECTURE.md)
- [índice de documentação](README.md)
