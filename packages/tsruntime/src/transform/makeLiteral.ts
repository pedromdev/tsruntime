import * as ts from 'typescript';

import * as cycle from './cycle';
import { ReflectedType, TypeKind } from './types';

function toLiteral(value: any): ts.Expression {
  if (Array.isArray(value)) {
    return ts.factory.createArrayLiteralExpression(value.map(toLiteral));
  } else if (value instanceof SkipParseLiteral) {
    return value.value;
  }

  switch (typeof value) {
    case 'string':
      return ts.factory.createStringLiteral(value);
    case 'number':
      return ts.factory.createNumericLiteral(value);
    case 'boolean':
      return value ? ts.factory.createTrue() : ts.factory.createFalse();
    case "undefined":
      return ts.factory.createIdentifier("undefined");
    case "bigint":
      return ts.factory.createBigIntLiteral(String(value));
    case "symbol":
      return ts.factory.createStringLiteral(String(value));
    case "object":
      return value === null
        ? ts.factory.createNull()
        : ts.factory.createObjectLiteralExpression(
          Object.entries(value)
            .filter(([_, v]) => v !== undefined)
            .map(([k, v]) => ts.factory.createPropertyAssignment(k, toLiteral(v)))
        );
    default:
      return ts.factory.createNull();
  }
}

class SkipParseLiteral {
  constructor(public readonly value: any) {}

  static all(value: any) {
    return new cycle.SkipCycle(new SkipParseLiteral(value));
  }
}

class LiteralCache {
  private cache = new Map<string, any>();

  has(type: ReflectedType) {
    return this.cache.has(this.getKey(type));
  }

  get(type: ReflectedType) {
    return this.cache.get(this.getKey(type));
  }

  set(type: ReflectedType, value: any) {
    this.cache.set(this.getKey(type), value);
  }

  private getKey(type: ReflectedType) {
    return type.id + '-' + type.kind;
  }

}

export function makeLiteral(type: ReflectedType, modifier?: ts.ModifierFlags): ts.ObjectLiteralExpression {
  const literalCache = new LiteralCache();
  const skipableCycleKinds = [TypeKind.StringLiteral, TypeKind.NumberLiteral];

  function parseTypeToLiteralValue(type: ReflectedType, modifiers?: ts.ModifierFlags): any {
    if (literalCache.has(type)) {
      const literalFromCache = literalCache.get(type);

      return skipableCycleKinds.includes(type.kind)
        ? new cycle.SkipCycle(literalFromCache)
        : literalFromCache;
    }

    const literal: Record<string, any> = {
      kind: type.kind,
      modifiers,
      initializer: ![undefined, null].includes(type.initializer as undefined | null)
        ? SkipParseLiteral.all(type.initializer)
        : type.initializer,
    };

    if (!skipableCycleKinds.includes(type.kind)) {
      literalCache.set(type, literal);
    }

    switch (type.kind) {
      case TypeKind.Object:
      case TypeKind.Class:
        literal.name = type.name;
        literal.properties = type.properties
          .reduce((acc, {name, type, modifiers}) => ({
            ...acc,
            [name.getText()]: parseTypeToLiteralValue(type, modifiers),
          }), {});
        // literal.arguments = type.arguments.map(arg => parseTypeToLiteralValue(arg));

        if (type.kind === TypeKind.Class) {
          literal.constructors = type.constructors.map(({modifiers, parameters}) => ({
            modifiers,
            parameters: parameters.map(({name, modifiers, type}) => ({
              name,
              modifiers,
              type: parseTypeToLiteralValue(type),
            })),
          }));

          if (type.extends !== undefined) {
            literal.extends = parseTypeToLiteralValue(type.extends);
          }
        }
        break;
      case TypeKind.Tuple:
        literal.elementTypes = type.elementTypes.map(el => parseTypeToLiteralValue(el));
        break;
      case TypeKind.Union:
        literal.types = type.types.map(tp => parseTypeToLiteralValue(tp));
        break;
      case TypeKind.StringLiteral:
      case TypeKind.NumberLiteral:
        literal.value = type.value;
        break;
      case TypeKind.Reference:
        literal.type = SkipParseLiteral.all(type.type);
        literal.arguments = type.arguments.map(arg => parseTypeToLiteralValue(arg));
        break;
    }

    return skipableCycleKinds.includes(type.kind)
      ? new cycle.SkipCycle(literal)
      : literal;
  }

  const value = parseTypeToLiteralValue(type, modifier);

  return toLiteral(cycle.decycle(value)) as ts.ObjectLiteralExpression;
}
