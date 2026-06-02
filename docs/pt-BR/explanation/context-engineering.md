# Engenharia de contexto

> Por que o GSD Core existe e qual problema ele foi projetado para resolver.

---

## O problema: degradação de contexto

Toda sessão de programação com IA começa do zero. O modelo lê sua pergunta, raciocina sobre ela e responde. Mas raramente uma sessão é composta de uma única troca. Você faz perguntas de acompanhamento, cola mensagens de erro, itera sobre o código, redireciona o modelo quando ele se desvia. Cada turno adiciona tokens à janela de contexto — o buffer finito de texto que o modelo consegue "enxergar" de uma só vez.

À medida que essa janela vai se preenchendo, algo sutil acontece. O modelo não falha de forma escancarada. Ele continua respondendo. Mas a qualidade das suas respostas vai se degradando silenciosamente. As instruções iniciais são empurradas para as bordas do que ele consegue atentar. A nuance das primeiras trocas — as restrições que você estabeleceu, a arquitetura que você acordou, os casos extremos que você sinalizou — compete por atenção com tudo o que veio depois. Pesquisadores chamam isso de **degradação de contexto** (*context rot*).

A degradação de contexto se manifesta de várias formas:

- O modelo começa a contradizer decisões anteriores que havia reconhecido.
- O estilo do código se distancia das convenções estabelecidas no início da sessão.
- Os planos passam a ignorar requisitos que foram claramente declarados, mas que agora estão soterrados no histórico.
- O modelo alucina nomes de arquivos ou assinaturas de funções que tinha corretos vinte mensagens atrás.

Nada disso é um bug do modelo. É uma propriedade fundamental de como a atenção de transformers funciona sobre sequências longas. O modelo não está esquecendo — ele nunca "lembrou" no sentido humano. Ele está ponderando a relevância ao longo de uma janela finita e, à medida que essa janela se preenche com ruído acumulado, a relação sinal-ruído se degrada.

A resposta ingênua é usar `/clear` e recomeçar. Mas isso perde a continuidade. Você precisa reexplicar o contexto, recolar os arquivos relevantes, reafirmar as restrições. A sessão essencialmente volta à estaca zero.

---

## A resposta do GSD Core: subagentes com contexto limpo

O insight central do GSD Core é que *a maior parte* do trabalho em uma sessão de programação não precisa acontecer no contexto principal. Pesquisa, planejamento, escrita de código e verificação são tarefas discretas e delimitadas. Cada uma pode ser entregue a um subagente especializado que começa com uma janela de contexto limpa e cuidadosamente delimitada — e reporta seu resultado de volta a um orquestrador enxuto que permanece leve.

Isso não é um contorno para a degradação de contexto. É uma solução estrutural.

O orquestrador — sua sessão principal — nunca toca os arquivos-fonte. Ele spawna agentes, coleta seus resultados, atualiza o estado compartilhado e encaminha para o próximo passo. Como ele faz muito pouco por conta própria, sua janela de contexto cresce de forma lenta e previsível. O trabalho pesado acontece em agentes que cada um começa do zero, recebe exatamente o contexto necessário para sua tarefa e termina quando concluído.

Considere o que isso significa na prática. Quando você executa `/gsd-plan-phase`, o orquestrador:

1. Carrega um payload de contexto JSON compacto (resumo do projeto, objetivo da fase, configuração relevante).
2. Spawna um agente pesquisador com uma janela limpa de 200k tokens.
3. Spawna um agente planejador com a saída da pesquisa e os requisitos da fase.
4. Spawna um agente verificador de plano para validar o plano antes da execução.

Cada agente opera com capacidade total, sem o peso do histórico acumulado da sua sessão. Quando o planejador escreve seus arquivos `PLAN.md` em `.planning/phases/`, essa saída se torna um artefato durável — não uma memória frágil em uma janela de contexto compartilhada.

---

## Desenvolvimento orientado a especificações e meta-prompting

A engenharia de contexto por si só não é suficiente. Se um agente começa do zero mas recebe instruções vagas, ele vai produzir saídas vagas. O GSD Core combina subagentes com contexto limpo com duas disciplinas complementares:

**Desenvolvimento orientado a especificações** significa que toda fase produz artefatos estruturados antes de a execução começar. Um `CONTEXT.md` captura as decisões de implementação da etapa Discuss. Um `RESEARCH.md` registra o que o pesquisador encontrou. Um `PLAN.md` divide o trabalho em tarefas discretas, ordenadas por dependência, com critérios de aceite explícitos. Quando um agente executor toca um arquivo, ele tem uma especificação precisa para seguir — não uma reinterpretação de uma conversa longa.

**Meta-prompting** significa que as próprias definições de agentes são prompts cuidadosamente engenheirados, não instruções ad-hoc. Os arquivos em `get-shit-done/workflows/` e `agents/` codificam conhecimento conquistado a duras penas sobre como delimitar tarefas, o que verificar e quando escalar para um checkpoint humano. O usuário não precisa reexplicar esse conhecimento a cada sessão; ele está integrado aos próprios prompts do sistema.

A combinação é deliberada. O contexto limpo garante que cada agente raciocine com clareza. Os artefatos orientados a especificações garantem que cada agente raciocine sobre a *coisa certa*. O meta-prompting garante que cada agente saiba *como* raciocinar bem sobre ela.

---

## O papel do `.planning/`

A engenharia de contexto exige que o conhecimento sobreviva a reinicializações de contexto. O GSD Core usa o sistema de arquivos para isso. Toda saída significativa é escrita em `.planning/` como Markdown ou JSON legível por humanos. Isso significa que:

- Reiniciar sua sessão (ou uma falha do modelo) não faz você perder trabalho.
- Qualquer agente subsequente pode ler artefatos anteriores diretamente, sem depender de um histórico de conversa compartilhado.
- Você pode inspecionar, editar ou commitar artefatos de planejamento no git — são texto simples, não estado opaco em um banco de dados.

`STATE.md` é a espinha dorsal desse sistema. Ele registra a posição atual do projeto (qual milestone, qual fase, quais planos estão completos), decisões ativas e bloqueadores, e métricas de progresso. Quando qualquer workflow começa, ele lê o `STATE.md` para se orientar. Quando qualquer workflow conclui uma etapa significativa, ele escreve de volta no `STATE.md`. Os agentes não dependem de memória; dependem do arquivo.

---

## Concessões e limitações

É importante ser honesto sobre as concessões envolvidas.

**Sobrecarga.** O ciclo de fases introduz atrito real. Executar `/gsd-discuss-phase`, `/gsd-plan-phase` e `/gsd-execute-phase` como etapas separadas leva mais tempo que digitar "escreva esse recurso" em uma sessão simples. Para uma mudança pequena e bem compreendida, essa sobrecarga não se justifica.

**Latência.** Spawnar múltiplos subagentes com contexto limpo é mais lento do que uma única edição no contexto. Pesquisa, planejamento e execução incorrem cada um em custos de ida e volta.

**Cerimônia para tarefas simples.** Se você precisa renomear uma variável, corrigir um erro de digitação ou adicionar um import ausente, o ciclo de fases é exagero. O GSD Core fornece `/gsd-quick` e `/gsd-fast` para trabalho ad-hoc que não justifica uma fase completa. Veja [Lidar com tarefas rápidas](../how-to/handle-quick-and-fast-tasks.md).

O ciclo de fases se paga quando o trabalho é suficientemente complexo para que a degradação de contexto seja um risco real — recursos com múltiplos arquivos, refatorações transversais, trabalho que se estende por horas ou sessões. Para todo o resto, recorra ao primitivo mais leve.

Uma regra de bolso útil: se a tarefa pudesse ser totalmente especificada em um prompt único e curto e concluída em um turno de agente sem mais esclarecimentos, pule o ciclo de fases. Se a tarefa requer pesquisa, envolve arquivos que você não leu recentemente, ou depende de decisões que ainda não estão definidas, o ciclo de fases te protege.

---

## Relacionados

- [O ciclo de fases](the-phase-loop.md) — como o ciclo Discuss → Plan → Execute → Verify → Ship coloca a engenharia de contexto em prática
- [Orquestração multi-agente](multi-agent-orchestration.md) — como subagentes são spawnados, delimitados e coordenados
- [Arquitetura](../ARCHITECTURE.md) — arquitetura do sistema, modelo de agentes e fluxo de dados
- [Índice de documentação](../README.md)
