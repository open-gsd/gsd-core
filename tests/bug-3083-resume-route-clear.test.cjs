'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('bug #3083: resume-project next-step routing should not include /clear then:', () => {
  test('route_to_workflow block omits /clear then: in resume templates', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'resume-project.md');
    const content = fs.readFileSync(workflowPath, 'utf-8');
    const routeStart = content.indexOf('<step name="route_to_workflow">');
    const routeEnd = content.indexOf('</step>', routeStart);
    const routeBlock = content.slice(routeStart, routeEnd);

    assert.equal(routeBlock.includes('/clear` then:'), false, 'resume route templates must not include `/clear` then:');
  });

  test('route_to_workflow block includes exception note explaining resume behavior', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'resume-project.md');
    const content = fs.readFileSync(workflowPath, 'utf-8');
    const routeStart = content.indexOf('<step name="route_to_workflow">');
    const routeEnd = content.indexOf('</step>', routeStart);
    const routeBlock = content.slice(routeStart, routeEnd);

    assert.match(routeBlock, /resume.*exception|exception.*resume/i);
  });
});
