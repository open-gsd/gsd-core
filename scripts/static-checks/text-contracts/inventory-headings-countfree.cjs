'use strict';

// docs/INVENTORY.md section headings carry no "(N shipped)" count scalar: a hard count on a heading line
// that two branches each edit undercounts silently when both add a module
// (DEFECT.INVENTORY-MERGE-UNDERCOUNT). Was tests/inventory-headings-countfree.test.cjs.

module.exports = {
  id: 'inventory-headings-countfree',
  check(ctx) {
    ctx.doc('docs/INVENTORY.md')
      .lacks(
        /^##[ \t]+.{1,300}\([0-9]{1,6}[ \t]+shipped\)/m,
        'docs/INVENTORY.md still has a hard-count "(N shipped)" heading (DEFECT.INVENTORY-MERGE-UNDERCOUNT); remove the parenthetical',
      );
  },
};
