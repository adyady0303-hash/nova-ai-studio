const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

test('new project button events never become the project name', () => {
  let opened = 0, focused = 0;
  const field = { value: 'Previous name', focus() { focused++; } };
  const context = vm.createContext({
    el: id => id === 'newProjectName' ? field : { showModal() { opened++; } },
    requestAnimationFrame: callback => callback()
  });
  vm.runInContext(source.slice(source.indexOf('function createProject('), source.indexOf('async function saveNewProject(')), context);
  context.createProject({ type: 'click', toString: () => '[object PointerEvent]' });
  assert.equal(field.value, '');
  context.createProject('Proiect din șablon');
  assert.equal(field.value, 'Proiect din șablon');
  assert.equal(opened, 2);
  assert.equal(focused, 2);
});
