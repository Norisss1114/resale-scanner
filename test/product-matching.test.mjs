import test from 'node:test';
import assert from 'node:assert/strict';

test('Select variant and model suffixes cannot match the base product', () => {
  assert.equal(evaluateListingMatch({ title: 'Amazon Fire TV Stick 4K Select' }, { brand: 'Amazon', title: 'Fire TV Stick 4K' }).matched, false);
  assert.equal(evaluateListingMatch({ title: 'Acme Drill AB123X' }, { brand: 'Acme', model: 'AB123', title: 'Drill' }).matched, false);
});
import { buildProductSearchPlan, evaluateListingMatch, extractKeyProductTokens, extractModelTokens, matchProfile, normalizeProductTitle } from '../lib/product-matching.mjs';

test('title normalization removes marketing noise but preserves model, size, and pack count', () => {
  assert.equal(normalizeProductTitle('NEW Premium DEWALT DCD771C2 20V 2 Pack - Free Shipping', 'DEWALT'), 'dewalt dcd771c2 20v 2 pack');
  assert.deepEqual(extractModelTokens('DEWALT DCD771C2 20V'), ['dcd771c2', '20v']);
});

test('key product tokens omit brand and generic marketing words', () => {
  const tokens = extractKeyProductTokens('Ring Premium Floodlight Cam Plus Bundle', 'Ring');
  assert.deepEqual(tokens, ['floodlight', 'cam', 'plus']);
});

test('search plan prioritizes exact UPC then brand and model', () => {
  const plan = buildProductSearchPlan({ brand: 'DEWALT', model: 'DCD771C2', upc_gtin_ean: '885911325905', product_name: '20V Drill Kit' });
  assert.equal(plan.queries[0].type, 'upc_exact');
  assert.equal(plan.queries[1].type, 'brand_model');
});

test('exact UPC match is accepted and a different UPC is rejected', () => {
  const product = { brand: 'Apple', upc_gtin_ean: '194252502000', product_name: 'AirTag 4 Pack' };
  assert.equal(evaluateListingMatch({ title: 'Apple AirTag 4 Pack', gtin: '194252502000' }, product).matchMethod, 'upc_exact');
  assert.equal(evaluateListingMatch({ title: 'Apple AirTag 4 Pack', gtin: '194252502999' }, product).matched, false);
});

test('brand and exact model match is accepted', () => {
  const result = evaluateListingMatch({ title: 'DEWALT 20V Drill DCD771C2' }, { brand: 'DEWALT', model: 'DCD771C2', product_name: '20V Drill Driver' });
  assert.deepEqual({ matched: result.matched, method: result.matchMethod }, { matched: true, method: 'brand_model' });
});

test('Fire TV Stick variants do not cross-match', () => {
  const base = { brand: 'Amazon', product_name: 'Fire TV Stick 4K' };
  assert.equal(evaluateListingMatch({ title: 'Amazon Fire TV Stick 4K Max' }, base).matched, false);
  assert.equal(evaluateListingMatch({ title: 'Amazon Fire TV Stick 4K Lite' }, base).matched, false);
});

test('Ring camera Plus and Pro variants do not cross-match', () => {
  const plus = { brand: 'Ring', product_name: 'Floodlight Cam Plus' };
  assert.equal(evaluateListingMatch({ title: 'Ring Floodlight Cam Pro' }, plus).matched, false);
  assert.equal(evaluateListingMatch({ title: 'Ring Floodlight Cam Plus' }, plus).matched, true);
});

test('match profile explains exact identifier and brand model methods', () => {
  assert.equal(matchProfile({ upc: '194252502000' }).level, 'Low');
  const product = { brand: 'Ninja', model: 'BL610' };
  const evidence = evaluateListingMatch({ title: 'Ninja BL610 Blender' }, product);
  assert.equal(matchProfile(product, [evidence]).matchMethod, 'brand_model');
});
