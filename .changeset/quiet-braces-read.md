---
type: Fixed
pr: 5724
---
**The secret-read guard now reads a bash 5.3 function substitution as a command** — `echo ${ cat .env; }`, `echo "${ cat .env; }"` and `echo ${| cat .env; REPLY=x; }` are denied like `echo $(cat .env)`, and a command holding one is also checked the way earlier bash reads it. (#5518)
