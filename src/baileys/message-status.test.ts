import { describe, expect, it } from 'vitest';
import { resolveMessageStatus } from './message-status.js';

describe('monotonic message status', () => {
  it('does not let a late SERVER_ACK overwrite READ', () => {
    expect(resolveMessageStatus('4', 2)).toBe('4');
    expect(resolveMessageStatus('4', '2')).toBe('4');
    expect(resolveMessageStatus('4', 'SERVER_ACK')).toBe('4');
  });

  it('advances receipts and replaces the received placeholder', () => {
    expect(resolveMessageStatus('received', 2)).toBe('2');
    expect(resolveMessageStatus('2', 3)).toBe('3');
    expect(resolveMessageStatus('3', 4)).toBe('4');
    expect(resolveMessageStatus('4', 5)).toBe('5');
    expect(resolveMessageStatus('4', 'PLAYED')).toBe('5');
    expect(resolveMessageStatus('received', 0)).toBe('0');
  });

  it('keeps deleted terminal and ignores unknown non-numeric states', () => {
    expect(resolveMessageStatus('4', 'deleted')).toBe('deleted');
    expect(resolveMessageStatus('deleted', 4)).toBe('deleted');
    expect(resolveMessageStatus('deleted', 'received')).toBe('deleted');
    expect(resolveMessageStatus('received', 'deleted')).toBe('deleted');
    expect(resolveMessageStatus('4', 'received')).toBe('4');
    expect(resolveMessageStatus('4', 'blue')).toBe('4');
    expect(resolveMessageStatus('received', 'blue')).toBe('received');
    expect(resolveMessageStatus('2', null)).toBe('2');
    expect(resolveMessageStatus('2', undefined)).toBe('2');
    expect(resolveMessageStatus('2', '')).toBe('2');
    expect(resolveMessageStatus('2', 2)).toBe('2');
  });

  it('stores named receipts as their numeric rank', () => {
    expect(resolveMessageStatus('received', 'READ')).toBe('4');
    expect(resolveMessageStatus('weird', 'DELIVERY_ACK')).toBe('3');
  });
});