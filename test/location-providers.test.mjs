import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocationProvider, TargetStoreProvider, WalmartStoreProvider,
  haversineMiles, normalizeStore, parseTargetStores, storesWithinRadius, validateZip
} from '../lib/location-providers.mjs';

test('ZIP validation accepts exactly five digits', () => {
  assert.equal(validateZip('60409'), true);
  assert.equal(validateZip('6040'), false);
  assert.equal(validateZip('60409-1234'), false);
  assert.equal(validateZip('abcde'), false);
});

test('Haversine distance is stable and radius filtering excludes unknown distance', () => {
  const chicagoToMilwaukee = haversineMiles({ latitude: 41.8781, longitude: -87.6298 }, { latitude: 43.0389, longitude: -87.9065 });
  assert.ok(chicagoToMilwaukee > 80 && chicagoToMilwaukee < 95);
  const stores = [{ id: 'near', distanceMiles: 4.9 }, { id: 'edge', distanceMiles: 5 }, { id: 'far', distanceMiles: 5.1 }, { id: 'unknown', distanceMiles: null }];
  assert.deepEqual(storesWithinRadius(stores, 5).map(store => store.id), ['near', 'edge']);
});

test('Store normalization calculates backend distance and preserves normalized fields', () => {
  const store = normalizeStore({ id: 731, retailer: 'Target', name: 'Highland', address: '10451 Indianapolis Blvd', city: 'Highland', state: 'in', zipCode: '46322-3511', latitude: 41.55, longitude: -87.47, storeUrl: 'https://www.target.com/sl/highland/731', source: 'target' }, { latitude: 41.61, longitude: -87.53 });
  assert.equal(store.id, '731');
  assert.equal(store.state, 'IN');
  assert.equal(store.zipCode, '46322');
  assert.ok(store.distanceMiles > 0);
});

test('Target official locator HTML normalizes store cards', () => {
  const html = '<a href="/sl/highland/731"><h3 class="title">Highland<span>store details</span></h3></a><div><a data-test="@store-locator/StoreAddress" href="#">10451 Indianapolis Blvd, Highland, IN 46322-3511</a></div>';
  const stores = parseTargetStores(html);
  assert.equal(stores.length, 1);
  assert.deepEqual({ id: stores[0].id, city: stores[0].city, state: stores[0].state, zipCode: stores[0].zipCode }, { id: '731', city: 'Highland', state: 'IN', zipCode: '46322' });
});

test('Store provider failure is isolated from a successful provider', async () => {
  const fetcher = async url => {
    if (String(url).includes('zippopotam')) return new Response(JSON.stringify({ places: [{ latitude: '41.60', longitude: '-87.55', 'place name': 'Calumet City', 'state abbreviation': 'IL' }] }), { status: 200 });
    if (String(url).includes('target.com')) return new Response('<a href="/sl/highland/731"><h3>Highland<span>details</span></h3></a><a data-test="@store-locator/StoreAddress">10451 Indianapolis Blvd, Highland, IN 46322</a>', { status: 200 });
    return new Response('blocked', { status: 403 });
  };
  const locationProvider = new LocationProvider({ fetcher });
  const location = await locationProvider.locate('60409');
  const settled = await Promise.all([new TargetStoreProvider({ fetcher, locationProvider }).listStores(location), new WalmartStoreProvider({ fetcher, locationProvider }).listStores(location)]);
  assert.equal(settled[0].status, 'ok');
  assert.equal(settled[1].status, 'unavailable');
});
