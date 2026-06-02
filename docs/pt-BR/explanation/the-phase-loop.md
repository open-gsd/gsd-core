# O loop de fases

> O modelo mental central de como o GSD Core organiza o trabalho.

---

## O que é o loop

O GSD Core estrutura todo o trabalho de desenvolvimento como um ciclo que se repete:

```text
Discuss → (UI design) → Plan → Execute → Verify → Ship
```

Cada unidade de trabalho — chamada de **fase** — percorre essas etapas em ordem. O loop não é uma formalidade. Cada etapa existe porque protege contra uma classe específica de falha que a etapa anterior, por si só, não consegue evitar.

Este documento explica *por que* o loop tem a forma que tem. Para instruções sobre como executar cada etapa, veja os guias práticos linkados ao final.

---

## Por que cada etapa existe

### Discuss

O planejamento não pode começar até que você saiba *como* construir a coisa, não apenas *o que* construir. O objetivo da fase em `ROADMAP.md` descreve o resultado. A etapa Discuss captura as decisões de implementação que moldam o caminho até esse resultado: quais bibliotecas, qual estratégia de tratamento de erros, se uma funcionalidade é por rota ou global, como os casos extremos devem se comportar.

Sem uma etapa Discuss, o planejador precisa tomar essas decisões por conta própria. Às vezes acerta. Muitas vezes acerta de forma plausível, mas errada — produzindo um plano coerente, porém desalinhado com suas preferências reais. Quando a execução termina e você percebe o erro, já está desfazendo um trabalho significativo.

A etapa Discuss é deliberadamente leve. É uma conversa, não um exercício de especificação. O resultado é um `CONTEXT.md` no diretório da fase: um registro estruturado de decisões que o planejador, executor e verificador podem ler. A conversa leva alguns minutos; pode economizar horas de retrabalho.

### UI design (opcional)

Para fases com componente visual, existe uma etapa opcional `/gsd-ui-phase` entre Discuss e Plan. Ela produz um `UI-SPEC.md` — um contrato de design que descreve layout, interação e comportamento visual antes de qualquer código ser escrito. Vale a pena executar essa etapa quando a interface é complexa o suficiente para que ambiguidades no design produzam escolhas de implementação divergentes. Um contrato de design claro é muito mais barato de escrever do que de reimplementar.

### Plan

A etapa Plan realiza a pesquisa, a decomposição e o raciocínio estrutural que a execução exige. Ela roda como uma sequência de subagentes com contexto zerado: um pesquisador que investiga o ecossistema e registra os achados em `RESEARCH.md`, um planejador que lê tanto a pesquisa quanto o `CONTEXT.md` para produzir os arquivos `PLAN.md`, e um verificador de planos que confere se os planos estão completos, consistentes e dentro do escopo.

O que um plano contém? Cada `PLAN.md` descreve uma unidade delimitada de trabalho: os arquivos a serem tocados, as mudanças específicas a serem feitas, os critérios de aceite que definem o que é "concluído". Os planos são ordenados em ondas de dependência para que a execução paralela seja segura — executores na mesma onda tocam preocupações que não se sobrepõem.

A etapa Plan é o momento em que a ambiguidade é mais cara. Um plano ambíguo produz um executor que faz suposições. Múltiplos executores paralelos fazendo suposições diferentes sobre a mesma preocupação produzem conflitos. O trabalho do verificador de planos é capturar isso antes de a execução começar, não depois.

### Execute

A execução roda os planos. Cada executor recebe uma janela de contexto zerada de 200k tokens carregada com exatamente o que precisa: o resumo do projeto, o contexto da fase, a pesquisa e o `PLAN.md` específico para sua tarefa. Nada mais.

Os executores escrevem código e fazem commits de forma atômica. Cada commit corresponde a uma tarefa concluída em um plano. Quando uma onda de executores paralelos termina, o orquestrador mescla o estado deles e inicia a próxima onda.

O contexto zerado do executor não é uma conveniência — é o mecanismo pelo qual a degradação de contexto é evitada. Um executor rodando com 180k tokens de histórico de sessão acumulado é um executor degradado. Um executor que começa do zero e lê apenas o que seu plano exige é um executor operando em plena capacidade.

### Verify

Após todos os executores terem concluído, um agente verificador lê o objetivo da fase, as decisões do `CONTEXT.md`, os planos e os resumos de execução — e verifica se o que foi construído corresponde ao que foi pretendido. Ele produz um `VERIFICATION.md` e, se houver discrepâncias, gera planos de correção direcionados.

A verificação não é apenas testes. Ela confere a cobertura de requisitos (todos os REQ-IDs foram endereçados?), a cobertura de decisões (as decisões capturadas no `CONTEXT.md` foram realmente implementadas?) e o alinhamento geral com o objetivo da fase. Uma fase não está concluída porque a execução terminou sem erros. Está concluída porque o que foi construído é o que foi planejado, e o que foi planejado é o que foi decidido.

### Ship

A etapa Ship cria o pull request e arquiva os artefatos da fase. O `STATE.md` é atualizado para marcar a fase como concluída. O loop então recomeça para a próxima fase.

---

## Marcos e fases

Um **marco** é um ciclo de versão — um incremento significativo e entregável do projeto. Tem um nome, um número de versão e um conjunto de requisitos que definem o que deve entregar. Um marco está completo quando todas as suas fases foram entregues e seus requisitos estão cobertos.

Uma **fase** é uma unidade de trabalho dentro de um marco. Uma fase tem um objetivo, um conjunto de requisitos que endereça e um conjunto de planos que a implementam.

A relação importa porque marcos e fases têm escopos de preocupação diferentes. Um marco pergunta: "O que esta versão do produto faz e o que ela não faz?" Uma fase pergunta: "Qual é a próxima coisa delimitada que podemos pesquisar, planejar, executar e verificar?"

Os limites dos marcos são traçados em fronteiras naturais do produto — uma API implantável, um fluxo de interface funcional, um modelo de dados completo. Os limites das fases são traçados nos limites do que pode ser executado com segurança em um loop sem que ele se torne incontrolável.

---

## O que define um bom escopo de fase

Vale a pena refletir sobre isso, pois é a fonte mais comum de atrito com o loop.

Uma fase muito grande torna-se um projeto de pesquisa em si mesma. O planejador tem dificuldade para decompô-la em planos independentes. Executores em ondas posteriores ficam bloqueados aguardando ondas anteriores. A verificação torna-se uma auditoria completa em vez de uma revisão direcionada. O ciclo de feedback se estende de horas para dias, e o risco de descobrir um erro de design fundamental tarde — após muito código ter sido escrito — aumenta drasticamente.

Uma fase muito pequena fragmenta trabalho que naturalmente pertence junto. Você acaba com arquivos de plano de meia dúzia de linhas, fases que completam em minutos e um custo de planejamento que supera em muito o custo de execução. O loop parece burocrático em vez de útil.

Um bom escopo de fase é aquele em que:

- O objetivo pode ser enunciado em uma única frase que não seja obviamente trivial nem suspeito de ser ampla demais.
- A pesquisa necessária para planejá-la é delimitada — as questões sobre o ecossistema têm respostas que não dependem de outras fases sendo concluídas primeiro.
- A execução pode ser paralelizada em um punhado de planos que não se sobrepõem, não dezenas.
- Existe uma definição clara e testável de "concluído" que um verificador pode checar sem ler todo o código-base.

Concretamente: "Adicionar middleware de validação de assinatura HMAC-SHA256" é um bom escopo de fase. "Construir o sistema de autenticação" geralmente não é — quase sempre contém múltiplas preocupações independentes que seriam melhor tratadas como fases separadas. "Corrigir o erro de digitação no README" está abaixo do limite onde o loop agrega valor; use `/gsd-quick` nesse caso.

Na dúvida, divida. Uma fase menor completa mais rápido, verifica com mais confiança e facilita a correção de curso se uma decisão de design se mostrar errada.

---

## Como `.planning/` transporta estado ao longo do loop

O loop não é uma sessão única. Pesquisa, planejamento e execução podem acontecer em múltiplas sessões, com reinicializações de contexto no meio. O diretório `.planning/` é o que torna isso possível.

Cada etapa do loop lê artefatos produzidos por etapas anteriores e escreve artefatos para etapas posteriores. O CONTEXT.md que a etapa Discuss produz ainda está disponível quando o Planejador roda — mesmo que isso ocorra em uma sessão diferente, horas depois. Os arquivos PLAN.md que o Planejador produz ainda estão disponíveis quando o Executor roda — mesmo após uma reinicialização. O VERIFICATION.md que o Verificador escreve ainda está disponível quando você revisa a fase.

`STATE.md` é a camada de navegação acima de tudo isso. Ele registra exatamente onde no loop o projeto está atualmente: qual marco está ativo, qual fase está em andamento, quais planos estão completos e quais estão pendentes. Qualquer agente ou fluxo de trabalho que precise se orientar lê o `STATE.md` primeiro.

Para a estrutura precisa desses arquivos, consulte [Artefatos de planejamento](../reference/planning-artifacts.md) e o [esquema do STATE.md](../reference/state-md.md).

---

## O loop é um ritmo, não uma restrição

É tentador ver o loop como burocracia — um conjunto de etapas obrigatórias que você tem que executar antes de ter permissão para escrever código. Essa visão está errada.

O loop existe porque cada etapa previne falhas que são genuinamente caras de corrigir depois. O Discuss previne o planejamento com base em suposições erradas. O Plan previne a execução de um design fundamentalmente quebrado. O Verify previne a entrega de trabalho que perdeu o escopo. Esses não são problemas inventados. São os modos de falha reais do desenvolvimento assistido por IA na escala de funcionalidades reais.

Quando o loop funciona bem, ele parece um ritmo: uma cadência de trabalho focado e delimitado em que cada etapa é clara porque a etapa anterior fez seu trabalho. O custo adicional é real, mas está concentrado no início — pago em minutos de planejamento em vez de horas de retrabalho.

Para trabalhos que ficam abaixo do limite em que o loop é justificado, o GSD Core oferece primitivas mais leves. O loop de fases é uma ferramenta, não a única ferramenta.

---

## Relacionados

- [Engenharia de contexto](context-engineering.md) — por que subagentes com contexto zerado evitam a degradação de qualidade que torna o loop necessário
- [Discutir uma fase](../how-to/discuss-a-phase.md)
- [Planejar uma fase](../how-to/plan-a-phase.md)
- [Executar uma fase](../how-to/execute-a-phase.md)
- [Verificar e entregar](../how-to/verify-and-ship.md)
- [Artefatos de planejamento](../reference/planning-artifacts.md)
- [Esquema do STATE.md](../reference/state-md.md)
- [índice de documentação](../README.md)
