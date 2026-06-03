# Orquestração multi-agente no GSD Core

> **Explicação** — Este documento descreve *por que* o GSD Core foi projetado em torno da
> orquestração multi-agente e *como as partes se encaixam*. Não é um guia
> passo a passo. Para configuração, consulte
> [Configurar perfis de modelo](../how-to/configure-model-profiles.md) e a
> [Referência de configuração](../CONFIGURATION.md). Para o catálogo completo de agentes,
> consulte [Inventário](../INVENTORY.md).

---

## O problema que este design resolve

Agentes de codificação com IA degradam. Não porque o modelo piora, mas porque a
*janela de contexto fica cheia*. À medida que uma conversa cresce, decisões e código
anteriores são expulsos ou diluídos pelo ruído das etapas intermediárias. Quando um
agente escreve o quinto arquivo em uma tarefa complexa, pode já ter esquecido
a restrição declarada na primeira mensagem. Isso é às vezes chamado de *podridão
de contexto* (*context rot*).

O design multi-agente do GSD Core é uma resposta direta a esse problema. Em vez de
um único agente de longa duração carregando toda a sessão, um orquestrador enxuto gera
agentes especializados de curta duração, cada um com uma **janela de contexto fresca de 200 K tokens**
e *somente os artefatos de que precisa* para realizar seu trabalho específico. O orquestrador
nunca faz o trabalho pesado por conta própria; ele carrega o contexto, gera o agente
adequado, coleta o resultado e atualiza o estado compartilhado em `.planning/`.

---

## O padrão orquestrador → agente

Todos os workflows em `get-shit-done/workflows/` seguem a mesma estrutura:

```text
Orquestrador (arquivo .md de workflow)
    │
    ├── Carregar contexto
    │   gsd-tools.cjs init <workflow> <phase>
    │   → JSON: informações do projeto, config, estado, detalhes da fase
    │
    ├── Resolver modelo
    │   gsd-tools.cjs resolve-model <agent-name>
    │   → opus | sonnet | haiku | inherit
    │
    ├── Gerar agente especializado (chamada Task/SubAgent)
    │   ├── Definição do agente (agents/*.md)
    │   ├── Payload de contexto (JSON de init)
    │   ├── Atribuição de modelo
    │   └── Permissões de ferramentas
    │
    ├── Coletar resultado
    │
    └── Atualizar estado
        gsd-tools.cjs state update / state patch / state advance-plan
```

O orquestrador é deliberadamente enxuto. Ele não raciocina sobre o domínio,
não escreve código e não interpreta resultados além de roteá-los para a
próxima etapa. Esse limite mantém a responsabilidade de cada camada clara e impede
que o contexto do orquestrador acumule ruído de domínio.

### O catálogo de agentes

Os agentes do GSD Core se enquadram em categorias funcionais que mapeiam o
pipeline pesquisa → planejamento → execução → verificação:

| Categoria | Agentes | Paralelismo típico |
|---|---|---|
| Pesquisadores | `gsd-project-researcher`, `gsd-phase-researcher`, `gsd-ui-researcher`, `gsd-advisor-researcher` | 4 em paralelo (stack, funcionalidades, arquitetura, armadilhas) |
| Sintetizadores | `gsd-research-synthesizer` | Sequencial, após a conclusão dos pesquisadores |
| Planejadores | `gsd-planner`, `gsd-roadmapper` | Sequencial |
| Verificadores | `gsd-plan-checker`, `gsd-integration-checker`, `gsd-ui-checker`, `gsd-nyquist-auditor` | Sequencial, até 3 iterações de revisão |
| Executores | `gsd-executor` | Paralelo dentro de uma onda, sequencial entre ondas |
| Validadores | `gsd-verifier` | Sequencial, após a conclusão de todos os executores |
| Mapeadores | `gsd-codebase-mapper` | 4 sub-sondas em paralelo |
| Auditores | `gsd-ui-auditor`, `gsd-security-auditor` | Sequencial |

Cada definição de agente (em `agents/*.md`) declara o acesso às ferramentas permitido,
a finalidade e a cor para saída no terminal. Um agente que só precisa ler arquivos
e escrever um único documento de saída recebe exatamente essas permissões — sem
execução de Bash, sem acesso a um estado mais amplo. Essa restrição é intencional: ela
mantém o raio de impacto pequeno caso um agente se comporte de forma inesperada.

Para o catálogo completo de 31 agentes, consulte [Inventário](../INVENTORY.md#agents-31-shipped).

---

## Execução paralela baseada em ondas

A expressão mais visível do design multi-agente é como o `/gsd-execute-phase`
lida com um conjunto de planos que podem depender uns dos outros.

Antes de gerar qualquer executor, o orquestrador realiza uma **análise de ondas**:
ele lê as declarações de dependência em cada arquivo `PLAN.md` e agrupa os planos
em ondas. Planos sem dependências declaradas formam a Onda 1 e executam em
paralelo. Planos que dependem da Onda 1 formam a Onda 2, e assim por diante.

```text
Plano 01 (sem deps)           ─┐
Plano 02 (sem deps)           ─┤─── Onda 1  (paralelo)
Plano 03 (depende de: 01)     ─┤─── Onda 2  (aguarda Onda 1)
Plano 04 (depende de: 02)     ─┘
Plano 05 (depende de: 03, 04)  ─── Onda 3  (aguarda Onda 2)
```

Cada executor dentro de uma onda:

- recebe uma janela de contexto fresca (200 K tokens, ou até 1 M em modelos capazes)
- recebe o `PLAN.md` específico pelo qual é responsável
- recebe o contexto do projeto (`PROJECT.md`, `STATE.md`)
- recebe o contexto da fase (`CONTEXT.md`, `RESEARCH.md` se disponível)
- produz commits git atômicos ao concluir
- escreve um `SUMMARY.md` descrevendo o que foi construído

Após a conclusão de todos os executores em uma onda, o orquestrador executa o hook
de pré-commit uma vez para a onda como um todo. Os executores fazem commit com `--no-verify` para
evitar contenção de bloqueio de build (por exemplo, conflitos de lock do Cargo em projetos
Rust) quando múltiplos agentes fazem commit em paralelo. O hook, portanto, é executado
uma vez por onda em vez de uma vez por commit.

### Segurança de commits paralelos

Dois mecanismos previnem conflitos de escrita quando múltiplos executores executam
simultaneamente:

1. **Lock atômico em `STATE.md`** — Toda escrita em `STATE.md` usa um
   arquivo de lock (`STATE.md.lock`) com criação atômica `O_EXCL`. Isso previne
   a corrida de leitura-modificação-escrita onde dois agentes leem o arquivo, modificam
   campos diferentes, e o escritor posterior sobrescreve as alterações do anterior.
   Locks obsoletos (com mais de 10 segundos) são automaticamente removidos.

2. **Execução de hook por onda** — Em vez de cada executor executar hooks de pré-commit
   de forma independente (o que pode causar contenção em nível de arquivo em artefatos
   de build compartilhados), o orquestrador executa `git hook run pre-commit` uma vez após
   a conclusão de cada onda.

---

## Enriquecimento adaptativo de contexto para modelos de janela grande

Janelas de contexto padrão de 200 K são suficientes para um executor implementar um
plano único e focado. Quando o `context_window` configurado é de 500 K tokens ou
maior (por exemplo, ao usar o Opus 4.6 ou Sonnet 4.6 no modo de 1 M), o orquestrador
automaticamente enriquece os prompts de subagentes com contexto adicional que não
caberia em uma janela padrão:

- **Agentes executores** recebem arquivos `SUMMARY.md` de ondas anteriores e o
  `CONTEXT.md`/`RESEARCH.md` da fase, fornecendo a eles consciência entre planos
  dentro da fase
- **Agentes validadores** recebem todos os arquivos `PLAN.md`, `SUMMARY.md` e `CONTEXT.md`
  mais `REQUIREMENTS.md`, habilitando verificação com consciência histórica

Esse enriquecimento é condicional ao valor de `context_window` em
`config.json`. Em configurações de janela padrão, os prompts usam versões truncadas
com ordenação favorável ao cache para maximizar a eficiência de tokens.

---

## Por que este design — a conexão com a engenharia de contexto

O padrão orquestrador → agente só faz sentido como parte de uma abordagem mais ampla
de *engenharia de contexto*: a ideia de que o que um agente de IA recebe em sua
janela de contexto importa tanto quanto o nível do modelo ou a qualidade do prompt. Consulte
[Engenharia de contexto](context-engineering.md) para o tratamento completo.

A orquestração multi-agente operacionaliza a engenharia de contexto de duas formas:

**Isolamento de contexto.** Cada agente recebe apenas o que precisa. Um pesquisador
recebe a descrição do projeto e as questões de domínio; ele não recebe o histórico
completo de planejamento. Um validador recebe todos os planos e resumos; ele não recebe
a pesquisa bruta. O isolamento mantém o contexto de cada agente denso em sinal em vez
de diluído pelo ruído de outros estágios do pipeline.

**Higiene de contexto entre sessões.** Como todo o estado vive em
`.planning/` como Markdown e JSON legíveis por humanos (não na janela de contexto
de nenhum agente), os workflows do GSD sobrevivem a resets de contexto (`/clear`), trocas de
abas e intervalos de vários dias. O próximo agente sempre começa a partir de artefatos
persistidos e verificados, em vez de uma memória reconstruída de uma longa conversa.

---

## Compensações

A orquestração multi-agente não é gratuita.

**Sobrecarga de coordenação.** Cada geração de agente é uma ida e volta: o orquestrador
deve formatar um prompt, repassar o contexto, aguardar a conclusão do subagente
(tipicamente 1–5 minutos) e então analisar o resultado. Um único agente capaz
trabalhando em um contexto terminaria mais rápido para tarefas simples. O GSD mitiga
isso tornando o paralelismo o padrão sempre que as dependências permitirem — os
quatro pesquisadores em um `plan-phase` executam simultaneamente, não sequencialmente.

**Opacidade durante a execução.** Enquanto um subagente está em execução, seu trabalho é
invisível para a sessão pai. Não há fluxo de progresso ao vivo. Esta é uma
consequência deliberada do design de contexto fresco: o subagente está operando
em sua própria janela de contexto. O orquestrador exibe uma nota de atividade na
linha de geração ("executado em um subagente — sem saída até retornar") para definir
expectativas.

**Custo de costura de contexto.** Empacotar os artefatos certos para cada agente
requer que o orquestrador gaste tokens montando e transmitindo payloads de contexto.
Este é o custo do isolamento. O handler `gsd-tools.cjs init`
produz um payload JSON que equilibra completude com orçamento de tokens, aplicando
ordenação favorável ao cache para que as partes estáveis do payload (definição do projeto,
config) acertem o cache em invocações repetidas.

**Amplificação do custo do modelo.** Executar cinco agentes em paralelo no nível Opus
custa mais do que executar um. O sistema de perfis de modelo (`model_profiles.md`,
resolvido por agente pelo `model-profiles.cjs`) permite atribuir níveis mais baratos a
agentes menos críticos. O recurso `dynamic_routing` reduz ainda mais o custo ao
iniciar cada agente em um nível mais barato e escalar apenas em caso de falha suave.
Consulte [Configuração](../CONFIGURATION.md) para as opções completas.

Em troca desses custos, o design compra *qualidade consistente em fases grandes*.
Um executor escrevendo o décimo arquivo em um plano de 400 linhas não degrada porque
seu contexto está fresco. Um validador verificando vinte requisitos não esquece os
primeiros dez porque os recebeu todos como entrada estruturada em vez de histórico
de conversa.

---

## Relacionados

- [Engenharia de contexto](context-engineering.md) — o princípio upstream que
  motiva este design
- [Configurar perfis de modelo](../how-to/configure-model-profiles.md) — como
  atribuir níveis de modelo por agente
- [Referência de configuração](../CONFIGURATION.md) — schema completo de `config.json`
  incluindo `models`, `model_overrides`, `dynamic_routing` e
  `context_window`
- [Inventário](../INVENTORY.md) — catálogo autoritativo de agentes e lista de workflows
- [Arquitetura](../ARCHITECTURE.md#agent-model) — detalhes em nível de implementação
  sobre o padrão orquestrador → agente e o modelo de execução por ondas
- [Índice de documentação](../README.md)
