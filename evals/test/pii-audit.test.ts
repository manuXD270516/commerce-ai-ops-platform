import { describe, expect, it } from 'vitest';
import { sensitiveKinds } from '../src/pii-audit.js';

describe('pii audit patterns', () => {
  it('flags a Luhn-valid card number, an email, a bearer token and a private JWK', () => {
    expect(sensitiveKinds('pago con 4111 1111 1111 1111')).toEqual(['card_number']);
    expect(sensitiveKinds('escribir a ana@example.com')).toEqual(['email']);
    expect(sensitiveKinds('Bearer aaa.bbb.ccc')).toEqual(['bearer_token']);
    expect(sensitiveKinds('{"d":"abcdefghijklmnopqrstuvwxyz"}')).toEqual(['private_key']);
  });

  it('does not mistake all-digit fixture UUIDs or non-Luhn digit runs for card numbers', () => {
    expect(sensitiveKinds('pedido 00000000-0000-4000-8000-000000000401')).toEqual([]);
    expect(sensitiveKinds('referencia 1234567890123')).toEqual([]);
  });
});
