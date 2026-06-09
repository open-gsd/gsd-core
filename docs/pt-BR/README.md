# Documentação do GSD Core

A documentação está organizada em quatro quadrantes: **tutoriais** ajudam você a aprender na prática, **guias de instruções** resolvem tarefas específicas, **referência** apresenta fatos autorizados, e **explicação** explora conceitos e decisões de design.

Versões por idioma: [English](../README.md) · [Português (pt-BR)](README.md) · [日本語](../ja-JP/README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md)

---

## Tutorials

- [Seu primeiro projeto](tutorials/your-first-project.md) — da instalação à primeira fase entregue, um caminho garantido
- [Integrando uma base de código existente](tutorials/onboarding-an-existing-codebase.md) — leve o GSD Core a um repositório já existente

---

## How-to guides

- [Instalar no seu ambiente de execução](how-to/install-on-your-runtime.md) — passos de instalação específicos para cada um dos 15 ambientes de execução suportados
- [Discutir uma fase](how-to/discuss-a-phase.md) — registrar decisões de implementação antes do início do planejamento
- [Planejar uma fase](how-to/plan-a-phase.md) — executar pesquisa, decompor o trabalho e verificar a qualidade do plano
- [Executar uma fase](how-to/execute-a-phase.md) — rodar planos em ondas paralelas com subagentes com contexto renovado
- [Verificar e entregar](how-to/verify-and-ship.md) — revisar o trabalho concluído, diagnosticar falhas e criar o PR
- [Rodar fases de forma autônoma](how-to/run-phases-autonomously.md) — usar o modo autônomo para execução de fases sem supervisão
- [Lidar com tarefas rápidas e ágeis](how-to/handle-quick-and-fast-tasks.md) — usar `/gsd-quick` e `/gsd-fast` para trabalho avulso fora do ciclo de fases
- [Configurar perfis de modelo](how-to/configure-model-profiles.md) — alternar entre níveis de modelo: qualidade, equilibrado e econômico
- [Configurar revisão entre IAs](how-to/set-up-cross-ai-review.md) — configurar uma segunda IA para revisar o código produzido pelo agente principal
- [Trabalhar em paralelo com workstreams](how-to/work-in-parallel-with-workstreams.md) — executar linhas de trabalho independentes simultaneamente usando workstreams
- [Isolar trabalho com workspaces](how-to/isolate-work-with-workspaces.md) — usar workspaces para isolar mudanças experimentais ou arriscadas
- [Depurar uma execução com falha](how-to/debug-a-failed-execution.md) — diagnosticar e recuperar de execuções de fase quebradas ou incompletas
- [Explorar e esboçar](how-to/spike-and-sketch.md) — usar `/gsd-spike` e `/gsd-sketch` para trabalho exploratório antes de comprometer com um plano
- [Projetar uma fase de UI](how-to/design-a-ui-phase.md) — usar o ciclo de fase de UI para trabalho de frontend e visual
- [Conduzir o GSD a partir de uma issue do rastreador](how-to/drive-gsd-from-a-tracker-issue.md) — iniciar uma fase a partir de uma issue do GitHub, Linear ou Jira
- [Migrar do GSD 2](how-to/migrate-from-gsd-2.md) — atualizar um projeto GSD 2 existente para o GSD Core
- [Atualizar o GSD](how-to/update-gsd.md) — executar novamente o instalador para obter a versão mais recente
- [Recuperar e solucionar problemas](how-to/recover-and-troubleshoot.md) — corrigir problemas comuns, reconstruir contexto e desinstalar

---

## Referência

- [Comandos](COMMANDS.md) — todos os comandos com flags e exemplos
- [Configuração](CONFIGURATION.md) — schema completo de configuração, perfis de modelo, estratégias de branching git
- [Ferramentas CLI](CLI-TOOLS.md) — API programática `gsd-tools.cjs` para workflows e agentes
- [Funcionalidades](FEATURES.md) — índice completo de funcionalidades
- [Inventário](INVENTORY.md) — skills instaladas e mapa de superfície
- [Schema do STATE.md](reference/state-md.md) — referência campo a campo para `.planning/STATE.md`
- [Schema do CONTEXT.md](reference/context-md.md) — referência campo a campo para `.planning/phases/<N>/CONTEXT.md`
- [Schema do PLAN.md](reference/plan-md.md) — referência campo a campo para `.planning/phases/<N>/PLAN.md`
- [Artefatos de planejamento](reference/planning-artifacts.md) — todos os arquivos `.planning/` e seus papéis

---

## Explicação

- [Engenharia de contexto](explanation/context-engineering.md) — como a degradação de contexto se forma e como o GSD Core a previne
- [O ciclo de fase](explanation/the-phase-loop.md) — racional de design para o ciclo Discuss → Plan → Execute → Verify → Ship
- [Orquestração multi-agente](explanation/multi-agent-orchestration.md) — como os subagentes são criados, delimitados e coordenados
- [Modelo de segurança](explanation/security-model.md) — limites de confiança, permissões e automação segura
- [Arquitetura](ARCHITECTURE.md) — arquitetura do sistema, modelo de agentes e fluxo de dados
- [Modos de discussão](workflow-discuss-mode.md) — modo de suposições vs. modo de entrevista para `/gsd-discuss-phase`
- [Monitoramento de contexto](context-monitor.md) — arquitetura do hook de monitoramento da janela de contexto
- [Orquestração orientada por issues](issue-driven-orchestration.md) — receita para conduzir o GSD a partir de uma issue do rastreador usando primitivos existentes

---

## Relacionados

- [README raiz](../README.md) — página inicial, início rápido e visão geral da documentação
- [Changelog](../../CHANGELOG.md) — histórico de versões
