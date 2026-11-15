import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount } from '../src/amount.js';
test('amounts stay exact across the full supported range',()=>{
  for(const value of ['0.00000001','1.00000000','0.10000001','21000000.00000000'])assert.equal(formatAmount(parseAmount(value)),value);
  assert.equal(parseAmount('1.1'),'110000000');
});
test('rejects floating notation, negative values, excess precision and overflow',()=>{
  for(const input of ['-1','1e8','0.000000001','NaN','21000001','1.2.3',''])assert.throws(()=>parseAmount(input));
});
