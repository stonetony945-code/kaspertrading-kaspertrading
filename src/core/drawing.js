/**
 * Core drawing logic.
 */
import { evaluate, evaluateAsync, getChartApi } from '../connection.js';

/**
 * createShape and createMultipointShape return a Promise, and the shape is not
 * in getAllShapes() until it resolves -- an immediate read gives the count from
 * before the call. This was papered over with a 200 ms sleep, which is the same
 * guess as every other fixed delay in this codebase: right until it isn't.
 *
 * Awaiting the promise removes the guess. The e2e suite showed what the guess
 * cost: draw_shape asserted on the returned value, got a Promise object, called
 * it a success, and draw_list then found nothing -- passing only on runs where
 * an unrelated shape happened to be on the chart.
 */
export async function drawShape({ shape, point, point2, overrides: overridesRaw, text }) {
  const overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  const create = point2
    ? `${apiPath}.createMultipointShape(
        [{ time: ${point.time}, price: ${point.price} }, { time: ${point2.time}, price: ${point2.price} }],
        { shape: '${shape}', overrides: ${overridesStr}, text: ${textStr} }
      )`
    : `${apiPath}.createShape(
        { time: ${point.time}, price: ${point.price} },
        { shape: '${shape}', overrides: ${overridesStr}, text: ${textStr} }
      )`;

  // The whole sequence runs in the page, so the before-snapshot, the await and
  // the after-snapshot cannot be separated by another caller's drawing.
  const result = await evaluateAsync(`
    (function() {
      var api = ${apiPath};
      var before = api.getAllShapes().map(function(s) { return s.id; });
      return Promise.resolve(${create}).then(function() {
        var after = api.getAllShapes().map(function(s) { return s.id; });
        var created = after.filter(function(id) { return before.indexOf(id) === -1; });
        return { entity_id: created.length ? created[0] : null, count: after.length };
      });
    })()
  `);

  if (!result?.entity_id) {
    throw new Error(`la forme '${shape}' n'a pas ete creee (${result?.count ?? '?'} formes sur le graphique)`);
  }
  return { success: true, shape, entity_id: result.entity_id };
}

export async function listDrawings() {
  const apiPath = await getChartApi();
  const shapes = await evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id }) {
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = '${entity_id}';
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

export async function removeOne({ entity_id }) {
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = '${entity_id}';
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

export async function clearAll() {
  const apiPath = await getChartApi();
  await evaluate(`${apiPath}.removeAllShapes()`);
  return { success: true, action: 'all_shapes_removed' };
}
