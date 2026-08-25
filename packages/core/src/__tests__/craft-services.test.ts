import test from 'node:test';
import assert from 'node:assert/strict';
import { isService, hasShelf, serviceProblem, NO_SHELF_WORDS } from '../craft-services.ts';

test('only the shop has services', () => {
  /**
   * A dish is not a service and neither is a drink. The kitchen counts
   * ingredients against recipes and the bar pours from bottles; neither has a
   * piece count on a product for this to be about, and a flag set on one of
   * their rows by an import or a copied record must not quietly change how it
   * behaves.
   */
  assert.equal(isService({ module: 'craft', is_service: true }), true);
  assert.equal(isService({ module: 'kitchen', is_service: true }), false);
  assert.equal(isService({ module: 'bar', is_service: true }), false);
  assert.equal(isService({ is_service: true }), false, 'no side means the kitchen');
});

test('anything written before this existed is goods', () => {
  /*
    Every craft product on file is a thing on a shelf, which is what it was.
    Reading an absent flag as "service" would take the entire shop off its own
    count sheet on the day this shipped.
  */
  assert.equal(isService({ module: 'craft' }), false);
  assert.equal(isService({ module: 'craft', is_service: false }), false);
  assert.equal(isService(null), false);
  assert.equal(isService(undefined), false);
});

test('having a shelf is the question everything else asks', () => {
  /**
   * One place, so the count sheet, the sale, the valuation and the approval
   * cannot end up disagreeing about whether alterations are on the shelf.
   */
  assert.equal(hasShelf({ module: 'craft' }), true);
  assert.equal(hasShelf({ module: 'craft', is_service: true }), false);
  // A dish has no shelf in this sense either — its stock leaves through a
  // recipe, not off a pile of pieces.
  assert.equal(hasShelf({ module: 'kitchen' }), false);
  assert.equal(hasShelf({ module: 'bar' }), false);
});

test('a product with pieces on the shelf cannot be turned into work', () => {
  /**
   * Work has no shelf, so calling this work would strand that stock: no count
   * sheet would ever ask about it again, no sale would take it off, and it
   * would sit in the shop for ever at whatever number it happened to hold.
   */
  assert.equal(serviceProblem({ onHand: 0 }), null);
  assert.match(serviceProblem({ onHand: 1 }) ?? '', /is 1 piece/);
  assert.match(serviceProblem({ onHand: 4 }) ?? '', /are 4 pieces/);
  assert.match(serviceProblem({ onHand: 4 }) ?? '', /Sell or write off/);

  // Sizes count. A product whose own figure is nothing can still have three
  // sizes with eleven pieces between them.
  assert.equal(serviceProblem({ onHand: 0, variantsOnHand: [0, 0] }), null);
  assert.match(serviceProblem({ onHand: 0, variantsOnHand: [3, 8] }) ?? '', /are 11 pieces/);
});

test('the form says what a service is instead of hiding a box', () => {
  /*
    A field that vanishes when a switch is flipped reads as something
    breaking, and the person who flipped it turns it back off to see whether
    that fixes it.
  */
  assert.match(NO_SHELF_WORDS, /never runs out/);
  assert.match(NO_SHELF_WORDS, /count sheet/);
  // And it says what a service still IS, not only what it is not. A shop
  // reading only the exclusions would not know the seamstress still gets paid.
  assert.match(NO_SHELF_WORDS, /credited/);
});
