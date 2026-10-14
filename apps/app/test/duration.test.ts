import assert from 'node:assert/strict';
import {it} from 'node:test';
import {describeDuration} from '../src/lib/data/quote.ts';
it('describes short repayment intervals without rounding them to a day',()=>{
 assert.equal(describeDuration(3600),'an hour');
 assert.equal(describeDuration(7200),'2 hours');
 assert.equal(describeDuration(900),'15 minutes');
 assert.equal(describeDuration(86400),'a day');
 assert.equal(describeDuration(604800),'a week');
});
