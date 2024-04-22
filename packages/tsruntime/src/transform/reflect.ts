import * as ts from "typescript";
import { ClassType, Constructor, ConstructorParameter, Ctx, ReflectedType, TypeKind, typescript } from "./types";

const typeCache = new Map<number, ReflectedType>();

namespace Normalizers {
  function normalizeBooleans(types: ReflectedType[]): ReflectedType[] {
    let hasFalse = false;
    let hasTrue = false;
    let hasBoolean = false;

    for (const type of types) {
      switch (type.kind) {
        case TypeKind.FalseLiteral:
          hasFalse = true;
          break;
        case TypeKind.TrueLiteral:
          hasTrue = true;
          break;
        case TypeKind.Boolean:
          hasBoolean = true;
          break;
      }
    }

    if (hasBoolean || (hasTrue && hasFalse)) {
      return [{ id: -1, kind: TypeKind.Boolean }];
    }
    return types;
  }

  export function normalizeUnion(types: ReflectedType[]) {
    const booleans: ReflectedType[] = [];
    const okTypes: ReflectedType[] = [];

    types.forEach(type => {
      switch (type.kind) {
        case TypeKind.FalseLiteral:
        case TypeKind.TrueLiteral:
        case TypeKind.Boolean:
          booleans.push(type);
          break;
        default:
          okTypes.push(type);
          break;
      }
    });

    const normalizedTypes: ReflectedType[] = [];

    if (booleans.length > 0) {
      normalizedTypes.push(...normalizeBooleans(booleans));
    }

    return okTypes.concat(normalizedTypes);
  }
}

export function getReflect(ctx: Ctx) {

  function serializeUnion(type: typescript.UnionType): ReflectedType {
    const nestedTypes = type.types.map(t => reflectType(t));
    const normalizedTypes = Normalizers.normalizeUnion(nestedTypes);
    return { id: type.id!, kind: TypeKind.Union, types: normalizedTypes };
  }

  function serializeReference(type: typescript.TypeReference): ReflectedType {
    const typeArgs = type.typeArguments;
    let allTypes: ReflectedType[] = [];
    if (typeArgs !== undefined) {
      allTypes = typeArgs.map(t => reflectType(t));
    }
    const target = type.target;
    if (target.objectFlags & ts.ObjectFlags.Tuple) {
      return { id: type.id!, kind: TypeKind.Tuple, elementTypes: allTypes };
    }
    const symbol = target.getSymbol()!;
    if (symbol.valueDeclaration === undefined) {
      return {
        id: type.id!,
        kind: TypeKind.Object,
        name: symbol.getName(),
        // arguments: allTypes,
        properties: []
      };
    } else {
      const typeName = getIdentifierForSymbol(target);
      return { id: type.id!, kind: TypeKind.Reference, arguments: allTypes, type: typeName };
    }
  }

  function getIdentifierForSymbol(type: typescript.Type): ts.Identifier {
    let name: string;

    const typenode = ctx.checker.typeToTypeNode(type, ctx.node, undefined)!; //todo not sure

    switch (typenode.kind) {
      case ts.SyntaxKind.TypeReference:
        const typename = (<ts.TypeReferenceNode>typenode).typeName;
        name = (<ts.Identifier>typename).text;
        let origSymb = type.getSymbol()!;
        if (origSymb.getFlags() & ts.SymbolFlags.Alias) {
          origSymb = ctx.checker.getAliasedSymbol(origSymb);
        }
        if (ctx.markReferenced) {
          ctx.markReferenced(origSymb);
        }
        break;
      default:
        name = type.getSymbol()!.getName();
    }
    const typeIdentifier = ts.factory.createIdentifier(name);
    (typeIdentifier as any).flags &= ~ts.NodeFlags.Synthesized;
    (typeIdentifier as any).parent = ctx.currentScope;
    return typeIdentifier;
  }

  function getPropertyName(symbol: ts.Symbol): ts.PropertyName {
    const { valueDeclaration } = symbol;
    if (valueDeclaration) {
      // if (!ts.isPropertySignature(valueDeclaration) && !ts.isPropertyDeclaration(valueDeclaration)) {
      // throw new Error("not prop signature");
      // }
      return (valueDeclaration as ts.PropertyDeclaration).name;
    }
    //@ts-ignore
    const nameType = symbol.nameType as ts.Type;

    const nameSymb = nameType.getSymbol();
    if (nameSymb) {
      return nameSymb.valueDeclaration as any;
    } else {
      //@ts-expect-error
      return ts.factory.createLiteral(nameType.value);
    }
  }

  function serializeInitializer(decl: {initializer?: ts.Expression}): ts.ArrowFunction | undefined {
    return decl.initializer
      ? ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, decl.initializer)
      : undefined;
  }

  function serializePropertySymbol(sym: ts.Symbol) {
    const decl = sym.declarations![0];
    const type = ctx.checker.getTypeOfSymbolAtLocation(sym, ctx.node);
    const serializedType = reflectType(type);
    const modifiers = ts.getCombinedModifierFlags(decl);

    const name = getPropertyName(sym);

    serializedType.initializer = ts.isPropertyDeclaration(sym.valueDeclaration!)
      ? serializeInitializer(sym.valueDeclaration)
      : undefined;

    return {
      name: name,
      modifiers,
      type: serializedType,
    };
  }

  function serializeConstructorParameter(param: ts.Symbol): ConstructorParameter {
    const decl = param.declarations![0];
    const type = reflectType(ctx.checker.getTypeOfSymbolAtLocation(param, decl));
    const modifiers = ts.getCombinedModifierFlags(decl);

    const initializer = param.valueDeclaration && ts.isParameter(param.valueDeclaration)
      ? serializeInitializer(param.valueDeclaration)
      : undefined;

    return {
      name: param.getName(),
      modifiers,
      type: {...type, initializer},
    };
  }

  function serializeConstructorSignature(sign: ts.Signature): Constructor {
    const parameters = sign.getParameters().map(serializeConstructorParameter);
    const decl = sign.getDeclaration()
    const modifiers = decl ? ts.getCombinedModifierFlags(decl) : 0;

    return {
      parameters,
      modifiers,
    }
  }

  function serializeObjectType(type: typescript.ObjectType): ReflectedType {
    const reflectedType = {
      id: type.id!,
    } as ReflectedType;
    const symbol = type.getSymbol()!;

    if (typeCache.has(type.id!)) {
      return typeCache.get(type.id!)!;
    } else {
      typeCache.set(type.id!, reflectedType);
    }

    if (type.getCallSignatures().length) {
      reflectedType.kind = TypeKind.Function;

      return reflectedType;
    }

    const reflectedType1 = reflectedType as any;
    reflectedType1.kind = TypeKind.Object;
    reflectedType1.name = (type.objectFlags & ts.ObjectFlags.Anonymous) ? undefined : symbol.getName();
    reflectedType1.properties = ctx.checker
      .getPropertiesOfType(type)
      .map(serializePropertySymbol);

    return reflectedType;
  }

  function serializeObject(type: typescript.ObjectType): ReflectedType {
    if (type.objectFlags & ts.ObjectFlags.Reference) {
      return serializeReference(<ts.TypeReference>type);
    }
    const symbol = type.getSymbol()!;

    if (symbol.flags & ts.SymbolFlags.Method) {
      return {
        id: type.id!,
        kind: TypeKind.Function
      }
    }

    if (symbol.valueDeclaration !== undefined) {
      const typeName = getIdentifierForSymbol(type);
      return { id: type.id!, kind: TypeKind.Reference, type: typeName, arguments: [] };
    }
    return serializeObjectType(type);

    // } else if (type.objectFlags & ts.ObjectFlags.Anonymous) {
    //   return {
    //     kind: TypeKind.Reference,
    //     type: ts.createIdentifier("Object"),
    //     arguments: []
    //   };
    // }
    // ctx.reportUnknownType(type);
    // return { kind: TypeKind.Unknown2 };
  }

  function reflectType(type: typescript.Type): ReflectedType {
    if (type.flags & ts.TypeFlags.Any) {
      return { id: type.id!, kind: TypeKind.Any };
    } else if (type.flags & ts.TypeFlags.StringLiteral) {
      return {
        id: type.id!,
        kind: TypeKind.StringLiteral,
        value: (type as ts.StringLiteralType).value
      };
    } else if (type.flags & ts.TypeFlags.NumberLiteral) {
      return {
        id: type.id!,
        kind: TypeKind.NumberLiteral,
        value: (type as ts.NumberLiteralType).value
      };
    } else if (type.flags & ts.TypeFlags.String) {
      return { id: type.id!, kind: TypeKind.String };
    } else if (type.flags & ts.TypeFlags.Number) {
      return { id: type.id!, kind: TypeKind.Number };
    } else if (type.flags & ts.TypeFlags.Boolean) {
      return { id: type.id!, kind: TypeKind.Boolean };
    } else if (type.flags & ts.TypeFlags.BooleanLiteral) {
      switch ((type as any).intrinsicName) {
        case "true":
          return { id: type.id!, kind: TypeKind.TrueLiteral };
        case "false":
          return { id: type.id!, kind: TypeKind.FalseLiteral };
      }
    } else if (type.flags & ts.TypeFlags.ESSymbol) {
      return { id: type.id!, kind: TypeKind.ESSymbol };
    } else if (type.flags & ts.TypeFlags.Void) {
      return { id: type.id!, kind: TypeKind.Void };
    } else if (type.flags & ts.TypeFlags.Undefined) {
      return { id: type.id!, kind: TypeKind.Undefined };
    } else if (type.flags & ts.TypeFlags.Null) {
      return { id: type.id!, kind: TypeKind.Null };
    } else if (type.flags & ts.TypeFlags.Never) {
      return { id: type.id!, kind: TypeKind.Never };
    } else if (type.flags & ts.TypeFlags.Unknown) {
      return { id: type.id!, kind: TypeKind.Unknown };
    } else if (type.flags & ts.TypeFlags.Object) {
      return serializeObject(<ts.ObjectType>type);
    } else if (type.flags & ts.TypeFlags.Union) {
      return serializeUnion(<ts.UnionType>type);
    }
    ctx.reportUnknownType(type);
    return { id: type.id!, kind: TypeKind.Unknown2 };
  }

  function reflectClass(
    type: typescript.InterfaceTypeWithDeclaredMembers,
  ): ClassType {
    const base = type.getBaseTypes()!;
    let extendsCls: ReflectedType | undefined;
    if (base.length > 0) {
      extendsCls = reflectType(base[0]);
    }
    const symbol = type.getSymbol()!;
    const name = symbol.getName();
    ctx.checker.getPropertiesOfType(type) //setting declaredProperties
    const properties = type.declaredProperties.filter(sym => sym.flags & ts.SymbolFlags.Property).map(serializePropertySymbol)

    const constructorType = ctx.checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!);
    const constructors = constructorType.getConstructSignatures().map(serializeConstructorSignature);

    return {
      id: type.id!,
      name: name!,
      properties,
      constructors,
      kind: TypeKind.Class,
      extends: extendsCls
    };
  }
  return {reflectClass, reflectType}
}
