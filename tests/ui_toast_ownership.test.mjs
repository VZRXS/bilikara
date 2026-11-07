import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {transform} from 'lightningcss';

function rules(source, classes) {
  const result = [];
  transform({filename: 'toast-ownership.css', code: Buffer.from(source), visitor: {Rule: {style(rule) {
    if (!rule.value.selectors.some(selector => selector.length === classes.length
      && selector.every((part, index) => part.type === 'class' && part.name === classes[index]))) return;
    assert.equal(rule.value.declarations.importantDeclarations.length, 0, 'base ownership cannot use !important');
    result.push(rule.value.declarations.declarations.map(declaration => declaration.property === 'unparsed'
      ? declaration.value.propertyId.property : declaration.property));
  }}}});
  return result;
}
const load = file => readFileSync(new URL('../static/' + file, import.meta.url), 'utf8');

test('toast base and error appearance have one shared owner; client variants own only their layer [P2-CSS]', () => {
  for (const file of ['styles.css', 'remote.css']) {
    assert.deepEqual(rules(load(file), ['app-toast']), [['z-index']], file);
    assert.deepEqual(rules(load(file), ['app-toast', 'is-error']), [], file);
  }
  const shared = load('ui-surfaces.css');
  const base = rules(shared, ['app-toast']);
  assert.equal(base.length, 1);
  for (const property of ['position', 'padding', 'border-radius', 'background', 'border', 'color', 'font-size', 'backdrop-filter'])
    assert.ok(base[0].includes(property), property);
  assert.ok(!base[0].includes('z-index'), 'Host/Remote stacking remains an explicit role variant');
  assert.deepEqual(rules(shared, ['app-toast', 'is-error']), [['color', 'border-color']]);
});

test('global fonts have one owner loaded by Host, Remote and audience [P2-CSS]', () => {
  for (const file of ['styles.css', 'remote.css', 'ui-surfaces.css']) {
    const names = [];
    transform({filename: file, code: Buffer.from(load(file)), visitor: {Declaration(declaration) {
      if (declaration.property === 'custom' && ['--font-sans', '--font-display'].includes(declaration.value.name))
        names.push(declaration.value.name);
    }}});
    assert.deepEqual(names, file === 'ui-surfaces.css' ? ['--font-sans', '--font-display'] : [], file);
  }
  for (const file of ['index.html', 'remote.html', 'controller.html'])
    assert.match(load(file), /href="\/ui-surfaces\.css"/, file);
});
