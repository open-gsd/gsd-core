---
type: Fixed
pr: 6421
---
**The secret-read guard reads a Bash word's brace groups as the words bash makes of it** — `cat {.env,x}`, `cat .e{n,x}v`, `cat {,.env}`, `grep .env{,}` and the same inside `bash -c '…'` were allowed and read `.env`, because the guard judged the unexpanded word. Each unquoted brace group is now expanded the way bash 5.2 does (nesting, cross products, empty alternatives, sequences) and every resulting word is judged like a plain one; quoted, escaped and comma-less groups stay literal. A word making more than 64 words is blocked as too complex unless it provably cannot change a verdict, so `for i in {1..120}`, `echo {1..100}` and `mkdir d{1..100}` stay allowed (#6142).
