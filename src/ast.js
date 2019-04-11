//
// This is pretty much a straight port of ast.c from CPython 2.6.5.
//
// The previous version was easier to work with and more JS-ish, but having a
// somewhat different ast structure than cpython makes testing more difficult.
//
// This way, we can use a dump from the ast module on any arbitrary python
// code and know that we're the same up to ast level, at least.
//

var SYM = Sk.ParseTables.sym;
var TOK = Sk.token.tokens;
var COMP_GENEXP = 0;
var COMP_LISTCOMP = 1;
var COMP_SETCOMP = 2;
var NULL = null;
var _slice_kind = { 
    Slice_kind: 1,
    ExtSlice_kind: 2, 
    Index_kind: 3
};

var _expr_kind = {
    BoolOp_kind: 1, NamedExpr_kind: 2, BinOp_kind: 3, UnaryOp_kind: 4,
    Lambda_kind: 5, IfExp_kind: 6, Dict_kind: 7, Set_kind: 8,
    ListComp_kind: 9, SetComp_kind: 10, DictComp_kind: 11,
    GeneratorExp_kind: 12, Await_kind: 13, Yield_kind: 14,
    YieldFrom_kind: 15, Compare_kind: 16, Call_kind: 17,
    FormattedValue_kind: 18, JoinedStr_kind: 19, Constant_kind: 20,
    Attribute_kind: 21, Subscript_kind: 22, Starred_kind: 23,
    Name_kind: 24, List_kind: 25, Tuple_kind: 26 };

/** @constructor */
function Compiling (encoding, filename, c_flags) {
    this.c_encoding = encoding;
    this.c_filename = filename;
    this.c_flags = c_flags || 0;
}

/**
 * @return {number}
 */
function NCH (n) {
    goog.asserts.assert(n !== undefined, "node must be defined");
    if (n.children === null) {
        return 0;
    }
    return n.children.length;
}

function CHILD (n, i) {
    goog.asserts.assert(n !== undefined, "node must be defined");
    goog.asserts.assert(i !== undefined, "index of child must be specified");
    return n.children[i];
}

function REQ (n, type) {
    goog.asserts.assert(n.type === type, "node wasn't expected type");
}

function TYPE(n) {
    return n.type;
}

function LINENO(n) {
    return n.lineno;
}

function STR(ch) {
    return ch.value;
}

function ast_error(c, n, msg) {
    throw new Sk.builtin.SyntaxError(msg, c.c_filename, n.lineno);
}

function strobj (s) {
    goog.asserts.assert(typeof s === "string", "expecting string, got " + (typeof s));
    return new Sk.builtin.str(s);
}

/** @return {number} */
function numStmts (n) {
    var ch;
    var i;
    var cnt;
    switch (n.type) {
        case SYM.single_input:
            if (CHILD(n, 0).type === TOK.T_NEWLINE) {
                return 0;
            }
            else {
                return numStmts(CHILD(n, 0));
            }
        case SYM.file_input:
            cnt = 0;
            for (i = 0; i < NCH(n); ++i) {
                ch = CHILD(n, i);
                if (ch.type === SYM.stmt) {
                    cnt += numStmts(ch);
                }
            }
            return cnt;
        case SYM.stmt:
            return numStmts(CHILD(n, 0));
        case SYM.compound_stmt:
            return 1;
        case SYM.simple_stmt:
            return Math.floor(NCH(n) / 2); // div 2 is to remove count of ;s
        case SYM.suite:
            if (NCH(n) === 1) {
                return numStmts(CHILD(n, 0));
            }
            else {
                cnt = 0;
                for (i = 2; i < NCH(n) - 1; ++i) {
                    cnt += numStmts(CHILD(n, i));
                }
                return cnt;
            }
            break;
        default:
            goog.asserts.fail("Non-statement found");
    }
    return 0;
}

function forbiddenCheck (c, n, x, lineno) {
    if (x instanceof Sk.builtin.str) {
        x = x.v;
    }
    if (x === "None") {
        throw new Sk.builtin.SyntaxError("assignment to None", c.c_filename, lineno);
    }
    if (x === "True" || x === "False") {
        throw new Sk.builtin.SyntaxError("assignment to True or False is forbidden", c.c_filename, lineno);
    }
}

/**
 * Set the context ctx for e, recursively traversing e.
 *
 * Only sets context for expr kinds that can appear in assignment context as
 * per the asdl file.
 */
function setContext (c, e, ctx, n) {
    var i;
    var exprName;
    var s;
    goog.asserts.assert(ctx !== Sk.ast.AugStore && ctx !== Sk.ast.AugLoad, "context not AugStore or AugLoad");
    s = null;
    exprName = null;

    switch (e.constructor) {
        case Sk.ast.Attribute:
        case Sk.ast.Name:
            if (ctx === Sk.ast.Store) {
                forbiddenCheck(c, n, e.attr, n.lineno);
            }
            e.ctx = ctx;
            break;
        case Sk.ast.Subscript:
            e.ctx = ctx;
            break;
        case Sk.ast.List:
            e.ctx = ctx;
            s = e.elts;
            break;
        case Sk.ast.Tuple:
            if (e.elts.length === 0) {
                throw new Sk.builtin.SyntaxError("can't assign to ()", c.c_filename, n.lineno);
            }
            e.ctx = ctx;
            s = e.elts;
            break;
        case Sk.ast.Lambda:
            exprName = "lambda";
            break;
        case Sk.ast.Call:
            exprName = "function call";
            break;
        case Sk.ast.BoolOp:
        case Sk.ast.BinOp:
        case Sk.ast.UnaryOp:
            exprName = "operator";
            break;
        case Sk.ast.GeneratorExp:
            exprName = "generator expression";
            break;
        case Sk.ast.Yield:
            exprName = "yield expression";
            break;
        case Sk.ast.ListComp:
            exprName = "list comprehension";
            break;
        case Sk.ast.SetComp:
            exprName = "set comprehension";
            break;
        case Sk.ast.DictComp:
            exprName = "dict comprehension";
            break;
        case Sk.ast.Dict:
        case Sk.ast.Set:
        case Sk.ast.Num:
        case Sk.ast.Str:
            exprName = "literal";
            break;
        case Sk.ast.Compare:
            exprName = "comparison";
            break;
        case Sk.ast.Repr:
            exprName = "repr";
            break;
        case Sk.ast.IfExp:
            exprName = "conditional expression";
            break;
        default:
            goog.asserts.fail("unhandled expression in assignment");
    }
    if (exprName) {
        throw new Sk.builtin.SyntaxError("can't " + (ctx === Sk.ast.Store ? "assign to" : "delete") + " " + exprName, c.c_filename, n.lineno);
    }

    if (s) {
        for (i = 0; i < s.length; ++i) {
            setContext(c, s[i], ctx, n);
        }
    }
}

var operatorMap = {};
(function () {
    operatorMap[TOK.T_VBAR] = Sk.ast.BitOr;
    operatorMap[TOK.T_CIRCUMFLEX] = Sk.ast.BitXor;
    operatorMap[TOK.T_AMPER] = Sk.ast.BitAnd;
    operatorMap[TOK.T_LEFTSHIFT] = Sk.ast.LShift;
    operatorMap[TOK.T_RIGHTSHIFT] = Sk.ast.RShift;
    operatorMap[TOK.T_PLUS] = Sk.ast.Add;
    operatorMap[TOK.T_MINUS] = Sk.ast.Sub;
    operatorMap[TOK.T_STAR] = Sk.ast.Mult;
    operatorMap[TOK.T_SLASH] = Sk.ast.Div;
    operatorMap[TOK.T_DOUBLESLASH] = Sk.ast.FloorDiv;
    operatorMap[TOK.T_PERCENT] = Sk.ast.Mod;
}());

function getOperator (n) {
    goog.asserts.assert(operatorMap[n.type] !== undefined, "Operator missing from operatorMap");
    return operatorMap[n.type];
}

function new_identifier(n, c) {
    return Sk.builtin.str(n);
}

function astForCompOp (c, n) {
    /* comp_op: '<'|'>'|'=='|'>='|'<='|'!='|'in'|'not' 'in'|'is'
     |'is' 'not'
     */
    REQ(n, SYM.comp_op);
    if (NCH(n) === 1) {
        n = CHILD(n, 0);
        switch (n.type) {
            case TOK.T_LESS:
                return Sk.ast.Lt;
            case TOK.T_GREATER:
                return Sk.ast.Gt;
            case TOK.T_EQEQUAL:
                return Sk.ast.Eq;
            case TOK.T_LESSEQUAL:
                return Sk.ast.LtE;
            case TOK.T_GREATEREQUAL:
                return Sk.ast.GtE;
            case TOK.T_NOTEQUAL:
                return Sk.ast.NotEq;
            case TOK.T_NAME:
                if (n.value === "in") {
                    return Sk.ast.In;
                }
                if (n.value === "is") {
                    return Sk.ast.Is;
                }
        }
    }
    else if (NCH(n) === 2) {
        if (CHILD(n, 0).type === TOK.T_NAME) {
            if (CHILD(n, 1).value === "in") {
                return Sk.ast.NotIn;
            }
            if (CHILD(n, 0).value === "is") {
                return Sk.ast.IsNot;
            }
        }
    }
    goog.asserts.fail("invalid comp_op");
}

function copy_location(e, n)
{
    if (e) {
        e.lineno = LINENO(n);
        e.col_offset = n.col_offset;
        e.end_lineno = n.end_lineno;
        e.end_col_offset = n.end_col_offset;
    }
    return e;
}

function seq_for_testlist (c, n) {
    /* testlist: test (',' test)* [',']
       testlist_star_expr: test|star_expr (',' test|star_expr)* [',']
    */
    var i;
    var seq = [];
    goog.asserts.assert(n.type === SYM.testlist ||
        n.type === SYM.testlist_star_expr ||
        n.type === SYM.listmaker ||
        n.type === SYM.testlist_comp ||
        n.type === SYM.testlist_safe ||
        n.type === SYM.testlist1, "node type must be listlike");
    for (i = 0; i < NCH(n); i += 2) {
        goog.asserts.assert(CHILD(n, i).type === SYM.test || CHILD(n, i).type === SYM.old_test || CHILD(n, i).type === SYM.star_expr);
        seq[i / 2] = ast_for_expr(c, CHILD(n, i));
    }
    return seq;
}

function astForSuite (c, n) {
    /* suite: simple_stmt | NEWLINE INDENT stmt+ DEDENT */
    var j;
    var num;
    var i;
    var end;
    var ch;
    var pos;
    var seq;
    REQ(n, SYM.suite);
    seq = [];
    pos = 0;
    if (CHILD(n, 0).type === SYM.simple_stmt) {
        n = CHILD(n, 0);
        /* simple_stmt always ends with an NEWLINE and may have a trailing
         * SEMI. */
        end = NCH(n) - 1;
        if (CHILD(n, end - 1).type === TOK.T_SEMI) {
            end -= 1;
        }
        for (i = 0; i < end; i += 2) // by 2 to skip ;
        {
            seq[pos++] = astForStmt(c, CHILD(n, i));
        }
    }
    else {
        for (i = 2; i < NCH(n) - 1; ++i) {
            ch = CHILD(n, i);
            REQ(ch, SYM.stmt);
            num = numStmts(ch);
            if (num === 1) {
                // small_stmt or compound_stmt w/ only 1 child
                seq[pos++] = astForStmt(c, ch);
            }
            else {
                ch = CHILD(ch, 0);
                REQ(ch, SYM.simple_stmt);
                for (j = 0; j < NCH(ch); j += 2) {
                    if (NCH(CHILD(ch, j)) === 0) {
                        goog.asserts.assert(j + 1 === NCH(ch));
                        break;
                    }
                    seq[pos++] = astForStmt(c, CHILD(ch, j));
                }
            }
        }
    }
    goog.asserts.assert(pos === numStmts(n));
    return seq;
}

function astForExceptClause (c, exc, body) {
    /* except_clause: 'except' [test [(',' | 'as') test]] */
    var e;
    REQ(exc, SYM.except_clause);
    REQ(body, SYM.suite);
    if (NCH(exc) === 1) {
        return new Sk.ast.ExceptHandler(null, null, astForSuite(c, body), exc.lineno, exc.col_offset);
    }
    else if (NCH(exc) === 2) {
        return new Sk.ast.ExceptHandler(ast_for_expr(c, CHILD(exc, 1)), null, astForSuite(c, body), exc.lineno, exc.col_offset);
    }
    else if (NCH(exc) === 4) {
        e = ast_for_expr(c, CHILD(exc, 3));
        setContext(c, e, Sk.ast.Store, CHILD(exc, 3));
        return new Sk.ast.ExceptHandler(ast_for_expr(c, CHILD(exc, 1)), e, astForSuite(c, body), exc.lineno, exc.col_offset);
    }
    goog.asserts.fail("wrong number of children for except clause");
}

function astForTryStmt (c, n) {
    var exceptSt;
    var i;
    var handlers;
    var nc = NCH(n);
    var nexcept = (nc - 3) / 3;
    var body, orelse = [],
        finally_ = null;

    REQ(n, SYM.try_stmt);
    body = astForSuite(c, CHILD(n, 2));
    if (CHILD(n, nc - 3).type === TOK.T_NAME) {
        if (CHILD(n, nc - 3).value === "finally") {
            if (nc >= 9 && CHILD(n, nc - 6).type === TOK.T_NAME) {
                /* we can assume it's an "else",
                 because nc >= 9 for try-else-finally and
                 it would otherwise have a type of except_clause */
                orelse = astForSuite(c, CHILD(n, nc - 4));
                nexcept--;
            }

            finally_ = astForSuite(c, CHILD(n, nc - 1));
            nexcept--;
        }
        else {
            /* we can assume it's an "else",
             otherwise it would have a type of except_clause */
            orelse = astForSuite(c, CHILD(n, nc - 1));
            nexcept--;
        }
    }
    else if (CHILD(n, nc - 3).type !== SYM.except_clause) {
        throw new Sk.builtin.SyntaxError("malformed 'try' statement", c.c_filename, n.lineno);
    }

    return new Sk.ast.Try(body, handlers, orelse, finally_, n.lineno, n.col_offset);
}

function astForDottedName (c, n) {
    var i;
    var e;
    var id;
    var col_offset;
    var lineno;
    REQ(n, SYM.dotted_name);
    lineno = n.lineno;
    col_offset = n.col_offset;
    id = strobj(CHILD(n, 0).value);
    e = new Sk.ast.Name(id, Sk.ast.Load, lineno, col_offset);
    for (i = 2; i < NCH(n); i += 2) {
        id = strobj(CHILD(n, i).value);
        e = new Sk.ast.Attribute(e, id, Sk.ast.Load, lineno, col_offset);
    }
    return e;
}

function astForDecorator (c, n) {
    /* decorator: '@' dotted_name [ '(' [arglist] ')' ] NEWLINE */
    var nameExpr;
    REQ(n, SYM.decorator);
    REQ(CHILD(n, 0), TOK.T_AT);
    REQ(CHILD(n, NCH(n) - 1), TOK.T_NEWLINE);
    nameExpr = astForDottedName(c, CHILD(n, 1));
    if (NCH(n) === 3) // no args
    {
        return nameExpr;
    }
    else if (NCH(n) === 5) // call with no args
    {
        return new Sk.ast.Call(nameExpr, [], [], null, null, n.lineno, n.col_offset);
    }
    else {
        return ast_for_call(c, CHILD(n, 3), nameExpr);
    }
}

function astForDecorators (c, n) {
    var i;
    var decoratorSeq;
    REQ(n, SYM.decorators);
    decoratorSeq = [];
    for (i = 0; i < NCH(n); ++i) {
        decoratorSeq[i] = astForDecorator(c, CHILD(n, i));
    }
    return decoratorSeq;
}

function astForDecorated (c, n) {
    var thing;
    var decoratorSeq;
    REQ(n, SYM.decorated);
    decoratorSeq = astForDecorators(c, CHILD(n, 0));
    goog.asserts.assert(CHILD(n, 1).type === SYM.funcdef || CHILD(n, 1).type === SYM.classdef);

    thing = null;
    if (CHILD(n, 1).type === SYM.funcdef) {
        thing = astForFuncdef(c, CHILD(n, 1), decoratorSeq);
    }
    else if (CHILD(n, 1) === SYM.classdef) {
        thing = astForClassdef(c, CHILD(n, 1), decoratorSeq);
    }
    if (thing) {
        thing.lineno = n.lineno;
        thing.col_offset = n.col_offset;
    }
    return thing;
}


/* with_item: test ['as' expr] */
function astForWithItem (c, n, content) {
    var expr_ty, context_expr, optional_vars;
    REQ(n, SYM.with_item);
    context_expr = ast_for_expr(c, CHILD(n, 0));
    if (NCH(n) == 3) {
        optional_vars = ast_for_expr(c, CHILD(n, 2));
        setContext(c, optional_vars, Sk.ast.Store, n);
    }

    return new With(context_expr, optional_vars, content, n.lineno, n.col_offset);
}

function astForWithStmt (c, n) {
    /* with_stmt: 'with' with_item (',' with_item)* ':' suite */
    var i;
    var ret
    var inner;

    REQ(n, SYM.with_stmt)

    /* process the with items inside-out */
    i = NCH(n) -1 
    /* the suite of the innermost with item is the suite of the with stmt */
    inner = astForSuite(c, CHILD(n,i));

    while (true) {
        i-=2;
        ret = astForWithItem(c, CHILD(n, i), inner)
        /* was this the last item? */
        if (i == 1) {
            break;
        }

        inner = [ret];
    } 

    return ret
}

function astForExecStmt (c, n) {
    var expr1, globals = null, locals = null;
    var nchildren = NCH(n);
    goog.asserts.assert(nchildren === 2 || nchildren === 4 || nchildren === 6);

    /* exec_stmt: 'exec' expr ['in' test [',' test]] */
    REQ(n, SYM.exec_stmt);
    expr1 = ast_for_expr(c, CHILD(n, 1));
    if (nchildren >= 4) {
        globals = ast_for_expr(c, CHILD(n, 3));
    }
    if (nchildren === 6) {
        locals = ast_for_expr(c, CHILD(n, 5));
    }
    return new Sk.ast.Exec(expr1, globals, locals, n.lineno, n.col_offset);
}

function astForIfStmt (c, n) {
    /* if_stmt: 'if' test ':' suite ('elif' test ':' suite)*
     ['else' ':' suite]
     */
    var off;
    var i;
    var orelse;
    var hasElse;
    var nElif;
    var decider;
    var s;
    REQ(n, SYM.if_stmt);
    if (NCH(n) === 4) {
        return new Sk.ast.If(
            ast_for_expr(c, CHILD(n, 1)),
            astForSuite(c, CHILD(n, 3)),
            [], n.lineno, n.col_offset);
    }

    s = CHILD(n, 4).value;
    decider = s.charAt(2); // elSe or elIf
    if (decider === "s") {
        return new Sk.ast.If(
            ast_for_expr(c, CHILD(n, 1)),
            astForSuite(c, CHILD(n, 3)),
            astForSuite(c, CHILD(n, 6)),
            n.lineno, n.col_offset);
    }
    else if (decider === "i") {
        nElif = NCH(n) - 4;
        hasElse = false;
        orelse = [];

        /* must reference the child nElif+1 since 'else' token is third, not
         * fourth child from the end. */
        if (CHILD(n, nElif + 1).type === TOK.T_NAME &&
            CHILD(n, nElif + 1).value.charAt(2) === "s") {
            hasElse = true;
            nElif -= 3;
        }
        nElif /= 4;

        if (hasElse) {
            orelse = [
                new Sk.ast.If(
                    ast_for_expr(c, CHILD(n, NCH(n) - 6)),
                    astForSuite(c, CHILD(n, NCH(n) - 4)),
                    astForSuite(c, CHILD(n, NCH(n) - 1)),
                    CHILD(n, NCH(n) - 6).lineno,
                    CHILD(n, NCH(n) - 6).col_offset)];
            nElif--;
        }

        for (i = 0; i < nElif; ++i) {
            off = 5 + (nElif - i - 1) * 4;
            orelse = [
                new Sk.ast.If(
                    ast_for_expr(c, CHILD(n, off)),
                    astForSuite(c, CHILD(n, off + 2)),
                    orelse,
                    CHILD(n, off).lineno,
                    CHILD(n, off).col_offset)];
        }
        return new Sk.ast.If(
            ast_for_expr(c, CHILD(n, 1)),
            astForSuite(c, CHILD(n, 3)),
            orelse, n.lineno, n.col_offset);
    }

    goog.asserts.fail("unexpected token in 'if' statement");
}

function ast_for_exprlist (c, n, context) {
    var e;
    var i;
    var seq;
    REQ(n, SYM.exprlist);
    seq = [];
    for (i = 0; i < NCH(n); i += 2) {
        e = ast_for_expr(c, CHILD(n, i));
        seq[i / 2] = e;
        if (context) {
            setContext(c, e, context, CHILD(n, i));
        }
    }
    return seq;
}

function astForDelStmt (c, n) {
    /* del_stmt: 'del' exprlist */
    REQ(n, SYM.del_stmt);
    return new Sk.ast.Delete(ast_for_exprlist(c, CHILD(n, 1), Sk.ast.Del), n.lineno, n.col_offset);
}

function astForGlobalStmt (c, n) {
    /* global_stmt: 'global' NAME (',' NAME)* */
    var i;
    var s = [];
    REQ(n, SYM.global_stmt);
    for (i = 1; i < NCH(n); i += 2) {
        s[(i - 1) / 2] = strobj(CHILD(n, i).value);
    }
    return new Sk.ast.Global(s, n.lineno, n.col_offset);
}

function astForAssertStmt (c, n) {
    /* assert_stmt: 'assert' test [',' test] */
    REQ(n, SYM.assert_stmt);
    if (NCH(n) === 2) {
        return new Sk.ast.Assert(ast_for_expr(c, CHILD(n, 1)), null, n.lineno, n.col_offset);
    }
    else if (NCH(n) === 4) {
        return new Sk.ast.Assert(ast_for_expr(c, CHILD(n, 1)), ast_for_expr(c, CHILD(n, 3)), n.lineno, n.col_offset);
    }
    goog.asserts.fail("improper number of parts to assert stmt");
}

function aliasForImportName (c, n) {
    /*
     import_as_name: NAME ['as' NAME]
     dotted_as_name: dotted_name ['as' NAME]
     dotted_name: NAME ('.' NAME)*
     */

    var i;
    var a;
    var name;
    var str;
    loop: while (true) {
        switch (n.type) {
            case SYM.import_as_name:
                str = null;
                name = strobj(CHILD(n, 0).value);
                if (NCH(n) === 3) {
                    str = CHILD(n, 2).value;
                }
                return new Sk.ast.alias(name, str == null ? null : strobj(str));
            case SYM.dotted_as_name:
                if (NCH(n) === 1) {
                    n = CHILD(n, 0);
                    continue loop;
                }
                else {
                    a = aliasForImportName(c, CHILD(n, 0));
                    goog.asserts.assert(!a.asname);
                    a.asname = strobj(CHILD(n, 2).value);
                    return a;
                }
                break;
            case SYM.dotted_name:
                if (NCH(n) === 1) {
                    return new Sk.ast.alias(strobj(CHILD(n, 0).value), null);
                }
                else {
                    // create a string of the form a.b.c
                    str = "";
                    for (i = 0; i < NCH(n); i += 2) {
                        str += CHILD(n, i).value + ".";
                    }
                    return new Sk.ast.alias(strobj(str.substr(0, str.length - 1)), null);
                }
                break;
            case TOK.T_STAR:
                return new Sk.ast.alias(strobj("*"), null);
            default:
                throw new Sk.builtin.SyntaxError("unexpected import name", c.c_filename, n.lineno);
        }
        break;
    }
}

function astForImportStmt (c, n) {
    /*
     import_stmt: import_name | import_from
     import_name: 'import' dotted_as_names
     import_from: 'from' ('.'* dotted_name | '.') 'import'
     ('*' | '(' import_as_names ')' | import_as_names)
     */
    var modname;
    var idx;
    var nchildren;
    var ndots;
    var mod;
    var i;
    var aliases;
    var col_offset;
    var lineno;
    REQ(n, SYM.import_stmt);
    lineno = n.lineno;
    col_offset = n.col_offset;
    n = CHILD(n, 0);
    if (n.type === SYM.import_name) {
        n = CHILD(n, 1);
        REQ(n, SYM.dotted_as_names);
        aliases = [];
        for (i = 0; i < NCH(n); i += 2) {
            aliases[i / 2] = aliasForImportName(c, CHILD(n, i));
        }
        return new Sk.ast.Import(aliases, lineno, col_offset);
    }
    else if (n.type === SYM.import_from) {
        mod = null;
        ndots = 0;

        for (idx = 1; idx < NCH(n); ++idx) {
            if (CHILD(n, idx).type === SYM.dotted_name) {
                mod = aliasForImportName(c, CHILD(n, idx));
                idx++;
                break;
            }
            else if (CHILD(n, idx).type !== TOK.T_DOT) {
                break;
            }
            ndots++;
        }
        ++idx; // skip the import keyword
        switch (CHILD(n, idx).type) {
            case TOK.T_STAR:
                // from ... import
                n = CHILD(n, idx);
                nchildren = 1;
                break;
            case TOK.T_LPAR:
                // from ... import (x, y, z)
                n = CHILD(n, idx + 1);
                nchildren = NCH(n);
                break;
            case SYM.import_as_names:
                // from ... import x, y, z
                n = CHILD(n, idx);
                nchildren = NCH(n);
                if (nchildren % 2 === 0) {
                    throw new Sk.builtin.SyntaxError("trailing comma not allowed without surrounding parentheses", c.c_filename, n.lineno);
                }
                break;
            default:
                throw new Sk.builtin.SyntaxError("Unexpected node-type in from-import", c.c_filename, n.lineno);
        }
        aliases = [];
        if (n.type === TOK.T_STAR) {
            aliases[0] = aliasForImportName(c, n);
        }
        else {
            for (i = 0; i < NCH(n); i += 2) {
                aliases[i / 2] = aliasForImportName(c, CHILD(n, i));
            }
        }
        modname = mod ? mod.name.v : "";
        return new Sk.ast.ImportFrom(strobj(modname), aliases, ndots, lineno, col_offset);
    }
    throw new Sk.builtin.SyntaxError("unknown import statement", c.c_filename, n.lineno);
}

function ast_for_testlistComp(c, n) {
    /* testlist_comp: test ( comp_for | (',' test)* [','] ) */
    /* argument: test [comp_for] */
    goog.asserts.assert(n.type === SYM.testlist_comp || n.type === SYM.argument);
    if (NCH(n) > 1 && CHILD(n, 1).type === SYM.comp_for) {
        return ast_for_gen_expr(c, n);
    }
    return ast_for_testlist(c, n);
}
function ast_for_genexp(c, n)
{
    goog.asserts.assert(TYPE(n) == SYM.testlist_comp || TYPE(n) == SYM.argument);
    return ast_for_itercomp(c, n, COMP_GENEXP);
}

function  ast_for_listcomp(c, n) {
    goog.asserts.assert(TYPE(n) == (SYM.testlist_comp));
    return ast_for_itercomp(c, n, COMP_LISTCOMP);
}

function astForFactor (c, n) {
    /* some random peephole thing that cpy does */
    var expression;
    var pnum;
    var patom;
    var ppower;
    var pfactor;
    if (CHILD(n, 0).type === TOK.T_MINUS && NCH(n) === 2) {
        pfactor = CHILD(n, 1);
        if (pfactor.type === SYM.factor && NCH(pfactor) === 1) {
            ppower = CHILD(pfactor, 0);
            if (ppower.type === SYM.power && NCH(ppower) === 1) {
                patom = CHILD(ppower, 0);
                if (patom.type === SYM.atom) {
                    pnum = CHILD(patom, 0);
                    if (pnum.type === TOK.T_NUMBER) {
                        pnum.value = "-" + pnum.value;
                        return ast_for_atom(c, patom);
                    }
                }
            }
        }
    }

    expression = ast_for_expr(c, CHILD(n, 1));
    switch (CHILD(n, 0).type) {
        case TOK.T_PLUS:
            return new Sk.ast.UnaryOp(Sk.ast.UAdd, expression, n.lineno, n.col_offset);
        case TOK.T_MINUS:
            return new Sk.ast.UnaryOp(Sk.ast.USub, expression, n.lineno, n.col_offset);
        case TOK.T_TILDE:
            return new Sk.ast.UnaryOp(Sk.ast.Invert, expression, n.lineno, n.col_offset);
    }

    goog.asserts.fail("unhandled factor");
}

function astForForStmt (c, n) {
    /* for_stmt: 'for' exprlist 'in' testlist ':' suite ['else' ':' suite] */
    var target;
    var _target;
    var nodeTarget;
    var seq = [];
    REQ(n, SYM.for_stmt);
    if (NCH(n) === 9) {
        seq = astForSuite(c, CHILD(n, 8));
    }
    nodeTarget = CHILD(n, 1);
    _target = ast_for_exprlist(c, nodeTarget, Sk.ast.Store);
    if (NCH(nodeTarget) === 1) {
        target = _target[0];
    }
    else {
        target = new Sk.ast.Tuple(_target, Sk.ast.Store, n.lineno, n.col_offset);
    }

    return new Sk.ast.For(target,
        ast_for_testlist(c, CHILD(n, 3)),
        astForSuite(c, CHILD(n, 5)),
        seq, n.lineno, n.col_offset);
}

function ast_for_call(c, n, func, allowgen)
{
    /*
      arglist: argument (',' argument)*  [',']
      argument: ( test [comp_for] | '*' test | test '=' test | '**' test )
    */

    var i, nargs, nkeywords;
    var ndoublestars;
    var args;
    var keywords;

    REQ(n, SYM.arglist);

    nargs = 0;
    nkeywords = 0;
    for (i = 0; i < NCH(n); i++) {
        var ch = CHILD(n, i);
        if (TYPE(ch) == SYM.argument) {
            if (NCH(ch) == 1) {
                nargs++;
            } else if (TYPE(CHILD(ch, 1)) == SYM.comp_for) {
                nargs++;
                if (!allowgen) {
                    ast_error(c, ch, "invalid syntax");
                    return NULL;
                }
                if (NCH(n) > 1) {
                    ast_error(c, ch, "Generator expression must be parenthesized");
                    return NULL;
                }
            } else if (TYPE(CHILD(ch, 0)) == TOK.T_STAR) {
                nargs++;
            } else {
                /* TYPE(CHILD(ch, 0)) == DOUBLESTAR or keyword argument */
                nkeywords++;
            }
        }
    }

    args = []
    keywords = []

    nargs = 0;  /* positional arguments + iterable argument unpackings */
    nkeywords = 0;  /* keyword arguments + keyword argument unpackings */
    ndoublestars = 0;  /* just keyword argument unpackings */
    for (i = 0; i < NCH(n); i++) {
        ch = CHILD(n, i);
        if (TYPE(ch) == SYM.argument) {
            var e;
            var chch = CHILD(ch, 0);
            if (NCH(ch) == 1) {
                /* a positional argument */
                if (nkeywords) {
                    if (ndoublestars) {
                        ast_error(c, chch,
                                "positional argument follows " +
                                "keyword argument unpacking");
                    } else {
                        ast_error(c, chch,
                                "positional argument follows " +
                                "keyword argument");
                    }
                    return NULL;
                }
                e = ast_for_expr(c, chch);
                if (!e) {
                    return NULL;
                }
                args[nargs++] = e;
            } else if (TYPE(chch) == TOK.T_STAR) {
                /* an iterable argument unpacking */
                var starred;
                if (ndoublestars) {
                    ast_error(c, chch,
                            "iterable argument unpacking follows " +
                            "keyword argument unpacking");
                    return NULL;
                }
                e = ast_for_expr(c, CHILD(ch, 1));
                if (!e) {
                    return NULL;
                }
                starred = new Sk.ast.Starred(e, Sk.ast.Load, LINENO(chch),
                        chch.col_offset);
                args[nargs++] = starred;
            } else if (TYPE(chch) == TOK.T_DOUBLESTAR) {
                /* a keyword argument unpacking */
                var kw;
                i++;
                e = ast_for_expr(c, CHILD(ch, 1));
                if (!e) {
                    return NULL;
                }
                kw = new Sk.ast.keyword(NULL, e);
                keywords[nkeywords++] = kw;
                ndoublestars++;
            } else if (TYPE(CHILD(ch, 1)) == SYM.comp_for) {
                /* the lone generator expression */
                e = ast_for_genexp(c, ch);
                if (!e) {
                    return NULL;
                }
                args[nargs++] = e;
            } else {
                /* a keyword argument */
                var kw;
                var key, tmp;
                var k;

                /* chch is test, but must be an identifier? */
                e = ast_for_expr(c, chch);
                if (!e) {
                    return NULL;
                }
                /* f(lambda x: x[0] = 3) ends up getting parsed with
                 * LHS test = lambda x: x[0], and RHS test = 3.
                 * SF bug 132313 points out that complaining about a keyword
                 * then is very confusing.
                 */
                if (e.kind == _expr_kind._Lambda_kind) {
                    ast_error(c, chch,
                            "lambda cannot contain assignment");
                    return NULL;
                }
                else if (e.kind != _expr_kind.Name_kind) {
                    ast_error(c, chch,
                            "keyword can't be an expression");
                    return NULL;
                }
                else if (forbiddenCheck(c, e.v.Name.id, ch, 1)) {
                    return NULL;
                }
                key = e.v.Name.id;
                for (k = 0; k < nkeywords; k++) {
                    tmp = keywords[k].arg;
                    if (tmp && tmp === key) {
                        ast_error(c, chch,
                                "keyword argument repeated");
                        return NULL;
                    }
                }
                e = ast_for_expr(c, CHILD(ch, 2));
                if (!e)
                    return NULL;
                kw = new Sk.ast.keyword(key, e);
                keywords[nkeywords++] = kw;
            }
        }
    }

    return new Sk.ast.Call(func, args, keywords, func.lineno, func.col_offset);
}

function ast_for_trailer(c, n, left_expr) {
    /* trailer: '(' [arglist] ')' | '[' subscriptlist ']' | '.' NAME
       subscriptlist: subscript (',' subscript)* [',']
       subscript: '.' '.' '.' | test | [test] ':' [test] [sliceop]
     */
    REQ(n, SYM.trailer);
    if (TYPE(CHILD(n, 0)) == TOK.T_LPAR) {
        if (NCH(n) == 2)
            return new Sk.ast.Call(left_expr, NULL, NULL, LINENO(n),
                        n.col_offset);
        else
            return ast_for_call(c, CHILD(n, 1), left_expr, true);
    }
    else if (TYPE(CHILD(n, 0)) == TOK.T_DOT) {
        var attr_id = new_identifier(CHILD(n, 1));
        if (!attr_id)
            return NULL;
        return new Sk.ast.Attribute(left_expr, attr_id, Sk.ast.Load,
                         LINENO(n), n.col_offset);
    }
    else {
        REQ(CHILD(n, 0), TOK.T_LSQB);
        REQ(CHILD(n, 2), TOK.T_RSQB);
        n = CHILD(n, 1);
        if (NCH(n) == 1) {
            var slc = astForSlice(c, CHILD(n, 0));
            if (!slc) {
                return NULL;
            }
            return new Sk.ast.Subscript(left_expr, slc, Sk.ast.Load, LINENO(n), n.col_offset);
        }
        else {
            /* The grammar is ambiguous here. The ambiguity is resolved
               by treating the sequence as a tuple literal if there are
               no slice features.
            */
            var j;
            var slc;
            var e;
            var simple = 1;
            var slices = [], elts;

            for (j = 0; j < NCH(n); j += 2) {
                slc = astForSlice(c, CHILD(n, j));
                if (!slc) {
                    return NULL;
                }
                if (slc.kind != _slice_kind.Index_kind) {
                    simple = 0;
                }
                slices[j / 2] = slc;
            }
            if (!simple) {
                return new Sk.ast.Subscript(left_expr, new Sk.ast.ExtSlice(slices),
                                Sk.ast.Load, LINENO(n), n.col_offset);
            }
            /* extract Index values and put them in a Tuple */
            elts = [];
            for (j = 0; j < slices.length; ++j) {
                slc = slices[j];
                assert(slc.kind == _slice_kind.Index_kind  && slc.v.Index.value);
                elts[j] = slc.v.Index.value;
            }
            e = new Sk.ast.Tuple(elts, Load, LINENO(n), n.col_offset);

            return new Sk.ast.Subscript(left_expr, new Sk.ast.Index(e),
                             Sk.ast.Load, LINENO(n), n.col_offset);
        }
    }
}

function ast_for_flow_stmt(c, n)
{
    /*
      flow_stmt: break_stmt | continue_stmt | return_stmt | raise_stmt
                 | yield_stmt
      break_stmt: 'break'
      continue_stmt: 'continue'
      return_stmt: 'return' [testlist]
      yield_stmt: yield_expr
      yield_expr: 'yield' testlist | 'yield' 'from' test
      raise_stmt: 'raise' [test [',' test [',' test]]]
    */
    var ch;

    REQ(n, SYM.flow_stmt);
    ch = CHILD(n, 0);
    switch (TYPE(ch)) {
        case SYM.break_stmt:
            return new Sk.ast.Break(LINENO(n), n.col_offset,
                         n.end_lineno, n.end_col_offset);
        case SYM.continue_stmt:
            return new Sk.ast.Continue(LINENO(n), n.col_offset,
                            n.end_lineno, n.end_col_offset);
        case SYM.yield_stmt: { /* will reduce to yield_expr */
            var exp = ast_for_expr(c, CHILD(ch, 0));
            if (!exp) {
                return null;
            }
            return new Sk.ast.Expr(exp, LINENO(n), n.col_offset,
                        n.end_lineno, n.end_col_offset);
        }
        case SYM.return_stmt:
            if (NCH(ch) == 1)
                return new Sk.ast.Return(null, LINENO(n), n.col_offset,
                              n.end_lineno, n.end_col_offset);
            else {
                var expression = ast_for_testlist(c, CHILD(ch, 1));
                if (!expression) {
                    return null;
                }
                return new Sk.ast.Return(expression, LINENO(n), n.col_offset,
                              n.end_lineno, n.end_col_offset);
            }
        case SYM.raise_stmt:
            if (NCH(ch) == 1)
                return new Sk.ast.Raise(null, null, LINENO(n), n.col_offset,
                             n.end_lineno, n.end_col_offset);
            else if (NCH(ch) >= 2) {
                var cause = null;
                var expression = ast_for_expr(c, CHILD(ch, 1));
                if (!expression) {
                    return null;
                }
                if (NCH(ch) == 4) {
                    cause = ast_for_expr(c, CHILD(ch, 3));
                    if (!cause) {
                        return null;
                    }
                }
                return new Sk.ast.Raise(expression, cause, LINENO(n), n.col_offset,
                             n.end_lineno, n.end_col_offset);
            }
            /* fall through */
        default:
            goog.asserts.fail("unexpected flow_stmt: ", TYPE(ch));
            return null;
    }
}

function astForArg(c, n)
{
    var name;
    var annotation = null;
    var ch;

    goog.asserts.assert(n.type === SYM.tfpdef || n.type === SYM.vfpdef);
    ch = CHILD(n, 0);
    forbiddenCheck(c, ch, ch.value, ch.lineno);
    name = strobj(ch.value);

    if (NCH(n) == 3 && CHILD(n, 1).type === TOK.T_COLON) {
        annotation = ast_for_expr(c, CHILD(n, 2));
    }

    return new Sk.ast.arg(name, annotation, n.lineno, n.col_offset);
}

/* returns -1 if failed to handle keyword only arguments
   returns new position to keep processing if successful
               (',' tfpdef ['=' test])*
                     ^^^
   start pointing here
 */
function handleKeywordonlyArgs(c, n, start, kwonlyargs, kwdefaults)
{
    var argname;
    var ch;
    var expression;
    var annotation;
    var arg;
    var i = start;
    var j = 0; /* index for kwdefaults and kwonlyargs */

    if (!kwonlyargs) {
        ast_error(c, CHILD(n, start), "named arguments must follow bare *");
    }
    goog.asserts.assert(kwdefaults);
    while (i < NCH(n)) {
        ch = CHILD(n, i);
        switch (ch.type) {
            case SYM.vfpdef:
            case SYM.tfpdef:
                if (i + 1 < NCH(n) && CHILD(n, i + 1).type == TOK.T_EQUAL) {
                    kwdefaults[j] = ast_for_expr(c, CHILD(n, i + 2));
                    i += 2; /* '=' and test */
                }
                else { /* setting NULL if no default value exists */
                    kwdefaults[j] = null;
                }
                if (NCH(ch) == 3) {
                    /* ch is NAME ':' test */
                    annotation = ast_for_expr(c, CHILD(ch, 2));
                }
                else {
                    annotation = null;
                }
                ch = CHILD(ch, 0);
                forbiddenCheck(c, ch, ch.value, ch.lineno);
                argname = strobj(ch.value);
                kwonlyargs[j++] = new Sk.ast.arg(argname, annotation, ch.lineno, ch.col_offset);
                i += 2; /* the name and the comma */
                break;
            case TOK.T_DOUBLESTAR:
                return i;
            default:
                ast_error(c, ch, "unexpected node");
        }
    }
    return i;
}

function astForArguments (c, n) {
    var k;
    var j;
    var i;
    var foundDefault;
    var posargs = [];
    var posdefaults = [];
    var kwonlyargs = [];
    var kwdefaults = [];
    var vararg = null;
    var kwarg = null;

    /* This function handles both typedargslist (function definition)
       and varargslist (lambda definition).

       parameters: '(' [typedargslist] ')'
       typedargslist: (tfpdef ['=' test] (',' tfpdef ['=' test])* [',' [
               '*' [tfpdef] (',' tfpdef ['=' test])* [',' ['**' tfpdef [',']]]
             | '**' tfpdef [',']]]
         | '*' [tfpdef] (',' tfpdef ['=' test])* [',' ['**' tfpdef [',']]]
         | '**' tfpdef [','])
       tfpdef: NAME [':' test]
       varargslist: (vfpdef ['=' test] (',' vfpdef ['=' test])* [',' [
               '*' [vfpdef] (',' vfpdef ['=' test])* [',' ['**' vfpdef [',']]]
             | '**' vfpdef [',']]]
         | '*' [vfpdef] (',' vfpdef ['=' test])* [',' ['**' vfpdef [',']]]
         | '**' vfpdef [',']
       )
       vfpdef: NAME

    */
    if (n.type === SYM.parameters) {
        if (NCH(n) === 2) // () as arglist
        {
            return new Sk.ast.arguments([], null, [], [], null, []);
        }
        n = CHILD(n, 1);
    }
    goog.asserts.assert(n.type === SYM.varargslist ||
                        n.type === SYM.typedargslist);


    // Skulpt note: the "counting numbers of args" section
    // from ast.c is omitted because JS arrays autoexpand

    /* tfpdef: NAME [':' test]
       vfpdef: NAME
    */
    i = 0;
    j = 0;  /* index for defaults */
    k = 0;  /* index for args */
    while (i < NCH(n)) {
        ch = CHILD(n, i);
        switch (ch.type) {
            case SYM.tfpdef:
            case SYM.vfpdef:
                /* XXX Need to worry about checking if TYPE(CHILD(n, i+1)) is
                   anything other than EQUAL or a comma? */
                /* XXX Should NCH(n) check be made a separate check? */
                if (i + 1 < NCH(n) && CHILD(n, i + 1).type == TOK.T_EQUAL) {
                    posdefaults[j++] = ast_for_expr(c, CHILD(n, i + 2));
                    i += 2;
                    foundDefault = 1;
                }
                else if (foundDefault) {
                    throw new Sk.builtin.SyntaxError("non-default argument follows default argument", c.c_filename, n.lineno);
                }
                posargs[k++] = astForArg(c, ch);
                i += 2; /* the name and the comma */
                break;
            case TOK.T_STAR:
                if (i+1 >= NCH(n) ||
                    (i+2 == NCH(n) && CHILD(n, i+1).type == TOK.T_COMMA)) {
                    throw new Sk.builtin.SyntaxError("named arguments must follow bare *", c.c_filename, n.lineno);
                }
                ch = CHILD(n, i+1);  /* tfpdef or COMMA */
                if (ch.type == TOK.T_COMMA) {
                    i += 2; /* now follows keyword only arguments */
                    i = handleKeywordonlyArgs(c, n, i,
                                                  kwonlyargs, kwdefaults);
                }
                else {
                    vararg = astForArg(c, ch);

                    i += 3;
                    if (i < NCH(n) && (CHILD(n, i).type == SYM.tfpdef
                                    || CHILD(n, i).type == SYM.vfpdef)) {
                        i = handleKeywordonlyArgs(c, n, i,
                                                      kwonlyargs, kwdefaults);
                    }
                }
                break;
            case TOK.T_DOUBLESTAR:
                ch = CHILD(n, i+1);  /* tfpdef */
                goog.asserts.assert(ch.type == SYM.tfpdef || ch.type == SYM.vfpdef);
                kwarg = astForArg(c, ch);
                i += 3;
                break;
            default:
                goog.asserts.fail("unexpected node in varargslist");
                return;
        }
    }
    return new Sk.ast.arguments(posargs, vararg, kwonlyargs, kwdefaults, kwarg, posdefaults);
}

function ast_for_funcdef(c, n, decorator_seq) {
    /* funcdef: 'def' NAME parameters ['->' test] ':' suite */
    return ast_for_funcdef_impl(c, n, decorator_seq,
        false /* is_async */);
}

function ast_for_funcdef_impl(c, n0, decorator_seq, is_async) {
    /* funcdef: 'def' NAME parameters ['->' test] ':' [TYPE_COMMENT] suite */
    var n = is_async ? CHILD(n0, 1) : n0;
    var name;
    var args;
    var body;
    var returns = NULL;
    var name_i = 1;
    var end_lineno, end_col_offset;
    var tc;
    var type_comment = NULL;

    if (is_async && c.c_feature_version < 5) {
        ast_error(c, n,
                  "Async functions are only supported in Python 3.5 and greater");
        return NULL;
    }

    REQ(n, SYM.funcdef);

    name = new_identifier(CHILD(n, name_i));

    if (forbiddenCheck(c, name, CHILD(n, name_i), 0)) {
        return NULL;
    }
    args = ast_for_arguments(c, CHILD(n, name_i + 1));
    if (!args) {
        return NULL;
    }
    if (TYPE(CHILD(n, name_i+2)) == TOK.T_RARROW) {
        returns = ast_for_expr(c, CHILD(n, name_i + 3));
        if (!returns) {
            return NULL
        }
        name_i += 2;
    }
    // if (TYPE(CHILD(n, name_i + 3)) == TOK.T_TYPE_COMMENT) {
    //     type_comment = NEW_TYPE_COMMENT(CHILD(n, name_i + 3));
    //     if (!type_comment) 
    //         return NULL;
    //     name_i += 1;
    // }
    body = ast_for_suite(c, CHILD(n, name_i + 3));
    if (!body) {
        return NULL;
    }
    // get_last_end_pos(body, &end_lineno, &end_col_offset);

    if (NCH(CHILD(n, name_i + 3)) > 1) {
        /* Check if the suite has a type comment in it. */
        tc = CHILD(CHILD(n, name_i + 3), 1);

        if (TYPE(tc) == TYPE_COMMENT) {
            if (type_comment != NULL) {
                ast_error(c, n, "Cannot have two type comments on def");
                return NULL;
            }
            type_comment = NEW_TYPE_COMMENT(tc);
            if (!type_comment)
                return NULL;
        }
    }

    if (is_async)
        return new Sk.ast.AsyncFunctionDef(name, args, body, decorator_seq, returns, type_comment,
                                LINENO(n0), n0.col_offset, end_lineno, end_col_offset);
    else
        return new Sk.ast.FunctionDef(name, args, body, decorator_seq, returns, type_comment,
                           LINENO(n), n.col_offset, end_lineno, end_col_offset);
}

function astForFuncdef(c, n0, decorator_seq, is_async)
{
    /* funcdef: 'def' NAME parameters ['->' test] ':' suite */
    var n = is_async ? CHILD(n0, 1) : n0;
    var name;
    var args;
    var body = [];
    var returns = null;
    var name_i = 1;

    REQ(n, SYM.funcdef);

    forbiddenCheck(c, CHILD(n, name_i), CHILD(n, name_i).value, n.lineno);
    name = strobj(CHILD(n, name_i).value);
    args = astForArguments(c, CHILD(n, name_i + 1));
    if (CHILD(n, name_i+2).type == TOK.T_RARROW) {
        returns = ast_for_expr(c, CHILD(n, name_i + 3));
        name_i += 2;
    }
    body = astForSuite(c, CHILD(n, name_i + 3));

    if (is_async)
        return new Sk.ast.AsyncFunctionDef(name, args, body, decorator_seq, returns, null /*docstring*/,
                                            n0.lineno, n0.col_offset);
    else
        return new Sk.ast.FunctionDef(name, args, body, decorator_seq, returns, null /*docstring*/,
                                        n.lineno, n.col_offset);
}

function astForAsyncFuncdef(c, n, decorator_seq)
{
    /* async_funcdef: 'async' funcdef */
    REQ(n, SYM.async_funcdef);
    REQ(CHILD(n, 0), TOK.T_NAME);
    goog.asserts.assert(CHILD(n, 0).value === "async");
    REQ(CHILD(n, 1), SYM.funcdef);

    return astForFuncdefImpl(c, n, decorator_seq,
                                true /* is_async */);
}

function astForClassBases (c, n) {
    /* testlist: test (',' test)* [','] */
    goog.asserts.assert(NCH(n) > 0);
    REQ(n, SYM.testlist);
    if (NCH(n) === 1) {
        return [ ast_for_expr(c, CHILD(n, 0)) ];
    }
    return seq_for_testlist(c, n);
}

function astForClassdef (c, n, decoratorSeq) {
    /* classdef: 'class' NAME ['(' arglist ')'] ':' suite */
    var classname;
    var call;
    var s;

    REQ(n, SYM.classdef);

    if (NCH(n) == 4) { /* class NAME ':' suite */
        s = astForSuite(c, CHILD(n, 3));
        classname = new_identifier(CHILD(n, 1).value);
        forbiddenCheck(c, CHILD(n,3), classname, n.lineno);

        return new Sk.ast.ClassDef(classname, [], [], s, decoratorSeq,
                                    /*TODO docstring*/null, LINENO(n), n.col_offset);
    }

    if (TYPE(CHILD(n, 3)) === TOK.T_RPAR) { /* class NAME '(' ')' ':' suite */
        s = astForSuite(c, CHILD(n, 5));
        classname = new_identifier(CHILD(n, 1).value);
        forbiddenCheck(c, CHILD(n, 3), classname, CHILD(n, 3).lineno);
        return new Sk.ast.ClassDef(classname, [], [], s, decoratorSeq,
                                    /*TODO docstring*/null, LINENO(n), n.col_offset);
    }

    /* class NAME '(' arglist ')' ':' suite */
    /* build up a fake Call node so we can extract its pieces */
    {
        var dummy_name;
        var dummy;
        dummy_name = new_identifier(CHILD(n, 1));
        dummy = new Sk.ast.Name(dummy_name, Sk.ast.Load, LINENO(n), n.col_offset);
        call = ast_for_call(c, CHILD(n, 3), dummy, false);
    }
    s = astForSuite(c, CHILD(n, 6));
    classname = new_identifier(CHILD(n, 1).value);
    forbiddenCheck(c, CHILD(n,1), classname, CHILD(n,1).lineno);

    return new Sk.ast.ClassDef(classname, call.args, call.keywords, s,
                               decoratorSeq, /*TODO docstring*/null, LINENO(n), n.col_offset);
}

function astForLambdef (c, n) {
    /* lambdef: 'lambda' [varargslist] ':' test */
    var args;
    var expression;
    if (NCH(n) === 3) {
        args = new Sk.ast.arguments([], null, null, []);
        expression = ast_for_expr(c, CHILD(n, 2));
    }
    else {
        args = astForArguments(c, CHILD(n, 1));
        expression = ast_for_expr(c, CHILD(n, 3));
    }
    return new Sk.ast.Lambda(args, expression, n.lineno, n.col_offset);
}

function astForComprehension(c, n) {
    /* testlist_comp: test ( comp_for | (',' test)* [','] )
       argument: test [comp_for] | test '=' test       # Really [keyword '='] test */
    
    var j;
    var ifs;
    var nifs;
    var ge;
    var expression;
    var t;
    var forch;
    var i;
    var ch;
    var genexps;
    var nfors;
    var elt;
    var comps;
    var comp;

    function countCompFors(c, n) {
        var nfors = 0;
        count_comp_for: while (true) {
            nfors++;
            REQ(n, SYM.comp_for);
            if (NCH(n) === 5) {
                n = CHILD(n, 4);
            } else {
                return nfors;
            }
            count_comp_iter: while (true) {
                REQ(n, SYM.comp_iter);
                n = CHILD(n, 0);
                if (n.type === SYM.comp_for) {
                    continue count_comp_for;
                } else if (n.type === SYM.comp_if) {
                    if (NCH(n) === 3) {
                        n = CHILD(n, 2);
                        continue count_comp_iter;
                    } else {
                        return nfors;
                    }
                }
                break;
            }
            break;
        }
        goog.asserts.fail("logic error in countCompFors");
    }

    function countCompIfs(c, n) {
        var nifs = 0;
        while (true) {
            REQ(n, SYM.comp_iter);
            if (CHILD(n, 0).type === SYM.comp_for) {
                return nifs;
            }
            n = CHILD(n, 0);
            REQ(n, SYM.comp_if);
            nifs++;
            if (NCH(n) === 2) {
                return nifs;
            }
            n = CHILD(n, 2);
        }
    }

    nfors = countCompFors(c, n);
    comps = [];
    for (i = 0; i < nfors; ++i) {
        REQ(n, SYM.comp_for);
        forch = CHILD(n, 1);
        t = ast_for_exprlist(c, forch, Sk.ast.Store);
        expression = ast_for_expr(c, CHILD(n, 3));
        if (NCH(forch) === 1) {
            comp = new Sk.ast.comprehension(t[0], expression, []);
        } else {
            comp = new Sk.ast.comprehension(new Sk.ast.Tuple(t, Sk.ast.Store, n.lineno, n.col_offset), expression, []);
        }
        if (NCH(n) === 5) {
            n = CHILD(n, 4);
            nifs = countCompIfs(c, n);
            ifs = [];
            for (j = 0; j < nifs; ++j) {
                REQ(n, SYM.comp_iter);
                n = CHILD(n, 0);
                REQ(n, SYM.comp_if);
                expression = ast_for_expr(c, CHILD(n, 1));
                ifs[j] = expression;
                if (NCH(n) === 3) {
                    n = CHILD(n, 2);
                }
            }
            if (n.type === SYM.comp_iter) {
                n = CHILD(n, 0);
            }
            comp.ifs = ifs;
        }
        comps[i] = comp;
    }
    return comps;
}

function astForIterComp(c, n, type) {
    var elt, comps;
    goog.asserts.assert(NCH(n) > 1);
    elt = ast_for_expr(c, CHILD(n, 0));
    comps = astForComprehension(c, CHILD(n, 1));
    if (type === COMP_GENEXP) {
        return new Sk.ast.GeneratorExp(elt, comps, n.lineno, n.col_offset);
    } else if (type === COMP_SETCOMP) {
        return new Sk.ast.SetComp(elt, comps, n.lineno, n.col_offset);
    }
}

/*
   Count the number of 'for' loops in a comprehension.
   Helper for ast_for_comprehension().
*/
function count_comp_fors(c, n) {
    var n_fors = 0;
    var is_async;
    count_comp_for: while (true) {
        // @meredydd needs new grammar
        // REQ(n, SYM.comp_for);
        // if (NCH(n) === 2) {
        //     REQ(CHILD(n, 0), TOK.T_ASYNC);
        //     n = CHILD(n, 1);
        // } else if (NCH(n) === 1) {
        //     n = CHILD(n, 0);
        // } else {
        //     goog.asserts.fail("logic error in count_comp_fors");
        // }
        // if (NCH(n) == (5)) {
        //     n = CHILD(n, 4);
        // } else {
        //     return n_fors;
        // }
        is_async = 0;
        n_fors++;
        REQ(n, SYM.comp_for);
        if (TYPE(CHILD(n, 0)) == TOK.T_ASYNC) {
            is_async = 1;
        }
        if (NCH(n) == (5 + is_async)) {
            n = CHILD(n, 4 + is_async);
        }
        else {
            return n_fors;
        }
        count_comp_iter: while (true) {
            REQ(n, SYM.comp_iter);
            n = CHILD(n, 0);
            if (TYPE(n) === SYM.comp_for) {
                continue count_comp_for;
            } else if (TYPE(n) === SYM.comp_if) {
                if (NCH(n) === 3) {
                    n = CHILD(n, 2);
                    continue count_comp_iter;
                } else {
                    return n_fors;
                }
            }
            break;
        }
        break;
    }
}

function count_comp_ifs(c, n)
{
    var n_ifs = 0;

    while (true) {
        REQ(n, SYM.comp_iter);
        if (TYPE(CHILD(n, 0)) == SYM.comp_for)
            return n_ifs;
        n = CHILD(n, 0);
        REQ(n, SYM.comp_if);
        n_ifs++;
        if (NCH(n) == 2) {
            return n_ifs;
        }
        n = CHILD(n, 2);
    }
}

function ast_for_comprehension(c, n) {
    var i, n_fors;
    var comps = [];
    n_fors = count_comp_fors(c, n);

    for (i = 0; i < n_fors; i++) {
        var comp;
        var t;
        var expression, first;
        var for_ch;
        var is_async = 0;

        if (TYPE(CHILD(n, 0)) == TOK.T_ASYNC) {
            is_async = 1;
        }

        for_ch = CHILD(n, 1 + is_async);
        t = ast_for_exprlist(c, for_ch, Sk.ast. Store);
        if (!t) {
            return null;
        }

        expression = ast_for_expr(c, CHILD(n, 3 + is_async));
        
        if (!expression) {
            return null;
        }
        
        // again new grammar needed 
        // REQ(n, SYM.comp_for);

        // if (NCH(n) == 2) {
        //     is_async = 1;
        //     REQ(CHILD(n, 0), TOK.T_ASYNC);
        //     sync_n = CHILD(n, 1);
        // }
        // else {
        //     sync_n = CHILD(n, 0);
        // }
        // REQ(sync_n, SYM.sync_comp_for);

        // /* Async comprehensions only allowed in Python 3.6 and greater */
        // /* @meredydd see below for the joys of the future! */
        // if (is_async && c.c_feature_version < 6) {
        //     ast_error(c, n,
        //               "Async comprehensions are only supported in Python 3.6 and greater");
        //     return null;
        // }

        // for_ch = CHILD(sync_n, 1);
        // t = ast_for_exprlist(c, for_ch, Sk.ast.Store);

        // expression = ast_for_expr(c, CHILD(sync_n, 3));

        /* Check the # of children rather than the length of t, since
           (x for x, in ...) has 1 element in t, but still requires a Tuple. */
        first = t[0];
        if (NCH(for_ch) == 1)
            comp = new Sk.ast.comprehension(first, expression, null, is_async);
        else
            comp = new Sk.ast.comprehension(new Sk.ast.Tuple(t, Sk.ast.Store, first.lineno, first.col_offset,
                                       for_ch.end_lineno, for_ch.end_col_offset),
                                 expression, null, is_async);

        if (NCH(n) == (5 + is_async)) {
            var j, n_ifs;
            var ifs = [];

            n = CHILD(n, 4 + is_async);
            n_ifs = count_comp_ifs(c, n);
            if (n_ifs == -1) {
                return null;
            }

            for (j = 0; j < n_ifs; j++) {
                REQ(n, SYM.comp_iter);
                n = CHILD(n, 0);
                REQ(n, SYM.comp_if);

                expression = ast_for_expr(c, CHILD(n, 1));
                if (!expression) {
                    return null;
                }
                
                ifs[j] = expression;
                if (NCH(n) == 3) {
                    n = CHILD(n, 2);
                }
            }
            /* on exit, must guarantee that n is a comp_for */
            if (TYPE(n) == SYM.comp_iter) {
                n = CHILD(n, 0);
            }
            comp.ifs = ifs;
        }
        // if (NCH(sync_n) == 5) {
        //     var j, n_ifs;
        //     var ifs = [];

        //     n = CHILD(sync_n, 4);
        //     n_ifs = count_comp_ifs(c, n);

        //     for (j = 0; j < n_ifs; j++) {
        //         REQ(n, comp_iter);
        //         n = CHILD(n, 0);
        //         REQ(n, comp_if);

        //         expression = ast_for_expr(c, CHILD(n, 1));
        //         if (!expression) {
        //             return null;
        //         }

        //         ifs[j] = expression;
        //         if (NCH(n) == 3) {
        //             n = CHILD(n, 2);
        //         }
        //     }
        //     /* on exit, must guarantee that n is a comp_for */
        //     if (TYPE(n) == SYM.comp_iter) {
        //         n = CHILD(n, 0);
        //     }
        //     comp.ifs = ifs;
        // }
        comps[i] = comp;
    }
    return comps;
}

function ast_for_itercomp(c, n, type) {
    /* testlist_comp: (test|star_expr)
     *                ( comp_for | (',' (test|star_expr))* [','] ) */
    var elt;
    var comps;
    var ch;

    goog.asserts.assert(NCH(n) > 1);

    ch = CHILD(n, 0);
    elt = ast_for_expr(c, ch);

    if (elt.constructor === Sk.ast.Starred) {
        ast_error(c, ch, "iterable unpacking cannot be used in comprehension");
        return NULL;
    }

    comps = ast_for_comprehension(c, CHILD(n, 1));

    if (type == COMP_GENEXP) {
        return new Sk.ast.GeneratorExp(elt, comps, LINENO(n), n.col_offset,
                            n.end_lineno, n.end_col_offset);
    } else if (type == COMP_LISTCOMP) {
        return new Sk.ast.ListComp(elt, comps, LINENO(n), n.col_offset,
                        n.end_lineno, n.end_col_offset);
    } else if (type == COMP_SETCOMP) {
        return new Sk.ast.SetComp(elt, comps, LINENO(n), n.col_offset,
                       n.end_lineno, n.end_col_offset);
    } else {
        /* Should never happen */
        return null;
    }
}

/* Fills in the key, value pair corresponding to the dict element.  In case
 * of an unpacking, key is NULL.  *i is advanced by the number of ast
 * elements.  Iff successful, nonzero is returned.
 */
function ast_for_dictelement(c, n, i)
{
    var expression;
    if (TYPE(CHILD(n, i)) == TOK.T_DOUBLESTAR) {
        goog.asserts.assert(NCH(n) - i >= 2);

        expression = ast_for_expr(c, CHILD(n, i + 1));

        return { key: null, value: expression, i: i + 2 }
    } else {
        goog.asserts.assert(NCH(n) - i >= 3);

        expression = ast_for_expr(c, CHILD(n, i));
        if (!expression)
            return 0;
        var key = expression;

        REQ(CHILD(n, i + 1), TOK.T_COLON);

        expression = ast_for_expr(c, CHILD(n, i + 2));
        if (!expression) {
            return false;
        }
        
        var value = expression;

        return { key: key, value: value, i: i + 3 };
    }
}

function ast_for_dictcomp(c, n) {
    var key, value;
    var comps = [];
    goog.asserts.assert(NCH(n) > 3);
    REQ(CHILD(n, 1), TOK.T_COLON);
    key = ast_for_expr(c, CHILD(n, 0));
    value = ast_for_expr(c, CHILD(n, 2));
    comps = astForComprehension(c, CHILD(n, 3));
    return new Sk.ast.DictComp(key, value, comps, n.lineno, n.col_offset);
}

function ast_for_dictdisplay(c, n)
{
    var i;
    var j;
    var keys = [], values = [];

    j = 0;
    for (i = 0; i < NCH(n); i++) {
        var res = ast_for_dictelement(c, n, i);
        i = res.i
        keys[j] = res.key;
        values[j] = res.value;
        j++;
    }

    return new Sk.ast.Dict(keys, values, LINENO(n), n.col_offset,
                n.end_lineno, n.end_col_offset);
}

function ast_for_gen_expr(c, n) {
    goog.asserts.assert(n.type === SYM.testlist_comp || n.type === SYM.argument);
    return astForIterComp(c, n, COMP_GENEXP);
}

function ast_for_setcomp(c, n) {
    goog.asserts.assert(n.type === SYM.dictorsetmaker);
    return astForIterComp(c, n, COMP_SETCOMP);
}

function astForWhileStmt (c, n) {
    /* while_stmt: 'while' test ':' suite ['else' ':' suite] */
    REQ(n, SYM.while_stmt);
    if (NCH(n) === 4) {
        return new Sk.ast.While(ast_for_expr(c, CHILD(n, 1)), astForSuite(c, CHILD(n, 3)), [], n.lineno, n.col_offset);
    }
    else if (NCH(n) === 7) {
        return new Sk.ast.While(ast_for_expr(c, CHILD(n, 1)), astForSuite(c, CHILD(n, 3)), astForSuite(c, CHILD(n, 6)), n.lineno, n.col_offset);
    }
    goog.asserts.fail("wrong number of tokens for 'while' stmt");
}

function astForAugassign (c, n) {
    REQ(n, SYM.augassign);
    n = CHILD(n, 0);
    switch (n.value.charAt(0)) {
        case "+":
            return Sk.ast.Add;
        case "-":
            return Sk.ast.Sub;
        case "/":
            if (n.value.charAt(1) === "/") {
                return Sk.ast.FloorDiv;
            }
            return Sk.ast.Div;
        case "%":
            return Sk.ast.Mod;
        case "<":
            return Sk.ast.LShift;
        case ">":
            return Sk.ast.RShift;
        case "&":
            return Sk.ast.BitAnd;
        case "^":
            return Sk.ast.BitXor;
        case "|":
            return Sk.ast.BitOr;
        case "*":
            if (n.value.charAt(1) === "*") {
                return Sk.ast.Pow;
            }
            return Sk.ast.Mult;
        default:
            goog.asserts.fail("invalid augassign");
    }
}

function astForBinop (c, n) {
    /* Must account for a sequence of expressions.
     How should A op B op C by represented?
     BinOp(BinOp(A, op, B), op, C).
     */
    var tmp;
    var newoperator;
    var nextOper;
    var i;
    var result = new Sk.ast.BinOp(
        ast_for_expr(c, CHILD(n, 0)),
        getOperator(CHILD(n, 1)),
        ast_for_expr(c, CHILD(n, 2)),
        n.lineno, n.col_offset);
    var nops = (NCH(n) - 1) / 2;
    for (i = 1; i < nops; ++i) {
        nextOper = CHILD(n, i * 2 + 1);
        newoperator = getOperator(nextOper);
        tmp = ast_for_expr(c, CHILD(n, i * 2 + 2));
        result = new Sk.ast.BinOp(result, newoperator, tmp, nextOper.lineno, nextOper.col_offset);
    }
    return result;
}

function ast_for_testlist (c, n) {
    /* testlist_comp: test (',' comp_for | (',' test)* [',']) */
    /* testlist: test (',' test)* [','] */
    goog.asserts.assert(NCH(n) > 0);
    if (n.type === SYM.testlist_comp) {
        if (NCH(n) > 1) {
            goog.asserts.assert(CHILD(n, 1).type !== SYM.comp_for);
        }
    }
    else {
        goog.asserts.assert(n.type === SYM.testlist || n.type === SYM.testlist_star_expr);
    }

    if (NCH(n) === 1) {
        return ast_for_expr(c, CHILD(n, 0));
    }
    else {
        return new Sk.ast.Tuple(seq_for_testlist(c, n), Sk.ast.Load, n.lineno, n.col_offset/*, c.c_arena */);
    }
}

function ast_for_exprStmt (c, n) {
    var expression;
    var value;
    var e;
    var i;
    var targets;
    var expr2;
    var varName;
    var expr1;
    var ch;
    REQ(n, SYM.expr_stmt);
    /* expr_stmt: testlist_star_expr (annassign | augassign (yield_expr|testlist) |
                            ('=' (yield_expr|testlist_star_expr))*)
       annassign: ':' test ['=' test]
       testlist_star_expr: (test|star_expr) (',' test|star_expr)* [',']
       augassign: '+=' | '-=' | '*=' | '@=' | '/=' | '%=' | '&=' | '|=' | '^='
                | '<<=' | '>>=' | '**=' | '//='
       test: ... here starts the operator precedence dance
     */
    if (NCH(n) === 1) {
        return new Sk.ast.Expr(ast_for_testlist(c, CHILD(n, 0)), n.lineno, n.col_offset);
    }
    else if (CHILD(n, 1).type === SYM.augassign) {
        ch = CHILD(n, 0);
        expr1 = ast_for_testlist(c, ch);
        setContext(c, expr1, Sk.ast.Store, ch);
        switch (expr1.constructor) {
            case Sk.ast.Name:
                varName = expr1.id;
                forbiddenCheck(c, ch, varName, n.lineno);
                break;
            case Sk.ast.Attribute:
            case Sk.ast.Subscript:
                break;
            case Sk.ast.GeneratorExp:
                throw new Sk.builtin.SyntaxError("augmented assignment to generator expression not possible", c.c_filename, n.lineno);
            case Sk.ast.Yield:
                throw new Sk.builtin.SyntaxError("augmented assignment to yield expression not possible", c.c_filename, n.lineno);
            default:
                throw new Sk.builtin.SyntaxError("illegal expression for augmented assignment", c.c_filename, n.lineno);
        }

        ch = CHILD(n, 2);
        if (ch.type === SYM.testlist) {
            expr2 = ast_for_testlist(c, ch);
        }
        else {
            expr2 = ast_for_expr(c, ch);
        }

        return new Sk.ast.AugAssign(expr1, astForAugassign(c, CHILD(n, 1)), expr2, n.lineno, n.col_offset);
    }
    else if (CHILD(n, 1).type === SYM.annassign) {
        // TODO translate the relevant section from ast.c
        throw new Sk.builtin.SyntaxError("Skulpt does not yet support type assignments", c.c_filename, n.lineno);
    }
    else {
        // normal assignment
        REQ(CHILD(n, 1), TOK.T_EQUAL);
        targets = [];
        for (i = 0; i < NCH(n) - 2; i += 2) {
            ch = CHILD(n, i);
            if (ch.type === SYM.yield_expr) {
                throw new Sk.builtin.SyntaxError("assignment to yield expression not possible", c.c_filename, n.lineno);
            }
            e = ast_for_testlist(c, ch);
            setContext(c, e, Sk.ast.Store, CHILD(n, i));
            targets[i / 2] = e;
        }
        value = CHILD(n, NCH(n) - 1);
        if (value.type === SYM.testlist_star_expr) {
            expression = ast_for_testlist(c, value);
        }
        else {
            expression = ast_for_expr(c, value);
        }
        return new Sk.ast.Assign(targets, expression, n.lineno, n.col_offset);
    }
}

function astForIfexpr (c, n) {
    /* test: or_test 'if' or_test 'else' test */
    goog.asserts.assert(NCH(n) === 5);
    return new Sk.ast.IfExp(
        ast_for_expr(c, CHILD(n, 2)),
        ast_for_expr(c, CHILD(n, 0)),
        ast_for_expr(c, CHILD(n, 4)),
        n.lineno, n.col_offset);
}

/**
 * s is a python-style string literal, including quote characters and u/r/b
 * prefixes. Returns decoded string object.
 */
function parsestr (c, s) {
    var encodeUtf8 = function (s) {
        return unescape(encodeURIComponent(s));
    };
    var decodeUtf8 = function (s) {
        return decodeURIComponent(escape(s));
    };
    var decodeEscape = function (s, quote) {
        var d3;
        var d2;
        var d1;
        var d0;
        var c;
        var i;
        var len = s.length;
        var ret = "";
        for (i = 0; i < len; ++i) {
            c = s.charAt(i);
            if (c === "\\") {
                ++i;
                c = s.charAt(i);
                if (c === "n") {
                    ret += "\n";
                }
                else if (c === "\\") {
                    ret += "\\";
                }
                else if (c === "t") {
                    ret += "\t";
                }
                else if (c === "r") {
                    ret += "\r";
                }
                else if (c === "b") {
                    ret += "\b";
                }
                else if (c === "f") {
                    ret += "\f";
                }
                else if (c === "v") {
                    ret += "\v";
                }
                else if (c === "0") {
                    ret += "\0";
                }
                else if (c === '"') {
                    ret += '"';
                }
                else if (c === '\'') {
                    ret += '\'';
                }
                else if (c === "\n") /* escaped newline, join lines */ {
                }
                else if (c === "x") {
                    d0 = s.charAt(++i);
                    d1 = s.charAt(++i);
                    ret += String.fromCharCode(parseInt(d0 + d1, 16));
                }
                else if (c === "u" || c === "U") {
                    d0 = s.charAt(++i);
                    d1 = s.charAt(++i);
                    d2 = s.charAt(++i);
                    d3 = s.charAt(++i);
                    ret += String.fromCharCode(parseInt(d0 + d1, 16), parseInt(d2 + d3, 16));
                }
                else {
                    // Leave it alone
                    ret += "\\" + c;
                    // goog.asserts.fail("unhandled escape: '" + c.charCodeAt(0) + "'");
                }
            }
            else {
                ret += c;
            }
        }
        return ret;
    };

    //print("parsestr", s);

    var quote = s.charAt(0);
    var rawmode = false;
    var unicode = false;

    // treats every sequence as unicodes even if they are not treated with uU prefix
    // kinda hacking though working for most purposes
    if((c.c_flags & Parser.CO_FUTURE_UNICODE_LITERALS || Sk.__future__.unicode_literals === true)) {
        unicode = true;
    }

    if (quote === "u" || quote === "U") {
        s = s.substr(1);
        quote = s.charAt(0);
        unicode = true;
    }
    else if (quote === "r" || quote === "R") {
        s = s.substr(1);
        quote = s.charAt(0);
        rawmode = true;
    }
    goog.asserts.assert(quote !== "b" && quote !== "B", "todo; haven't done b'' strings yet");

    goog.asserts.assert(quote === "'" || quote === '"' && s.charAt(s.length - 1) === quote);
    s = s.substr(1, s.length - 2);
    if (unicode) {
        s = encodeUtf8(s);
    }

    if (s.length >= 4 && s.charAt(0) === quote && s.charAt(1) === quote) {
        goog.asserts.assert(s.charAt(s.length - 1) === quote && s.charAt(s.length - 2) === quote);
        s = s.substr(2, s.length - 4);
    }

    if (rawmode || s.indexOf("\\") === -1) {
        return strobj(decodeUtf8(s));
    }
    return strobj(decodeEscape(s, quote));
}

function parsestrplus (c, n) {
    var i;
    var ret;
    REQ(CHILD(n, 0), TOK.T_STRING);
    ret = new Sk.builtin.str("");
    for (i = 0; i < NCH(n); ++i) {
        try {
            ret = ret.sq$concat(parsestr(c, CHILD(n, i).value));
        } catch (x) {
            throw new Sk.builtin.SyntaxError("invalid string (possibly contains a unicode character)", c.c_filename, CHILD(n, i).lineno);
        }
    }
    return ret;
}

function parsenumber (c, s, lineno) {
    var neg;
    var val;
    var tmp;
    var end = s.charAt(s.length - 1);

    // call internal complex type constructor for complex strings
    if (end === "j" || end === "J") {
        return Sk.builtin.complex.complex_subtype_from_string(s);
    }

    // Handle longs
    if (end === "l" || end === "L") {
        return Sk.longFromStr(s.substr(0, s.length - 1), 0);
    }

    // todo; we don't currently distinguish between int and float so
    // str is wrong for these.
    if (s.indexOf(".") !== -1) {
        return new Sk.builtin.float_(parseFloat(s));
    }

    // Handle integers of various bases
    tmp = s;
    neg = false;
    if (s.charAt(0) === "-") {
        tmp = s.substr(1);
        neg = true;
    }

    if (tmp.charAt(0) === "0" && (tmp.charAt(1) === "x" || tmp.charAt(1) === "X")) {
        // Hex
        tmp = tmp.substring(2);
        val = parseInt(tmp, 16);
    } else if ((s.indexOf("e") !== -1) || (s.indexOf("E") !== -1)) {
        // Float with exponent (needed to make sure e/E wasn't hex first)
        return new Sk.builtin.float_(parseFloat(s));
    } else if (tmp.charAt(0) === "0" && (tmp.charAt(1) === "b" || tmp.charAt(1) === "B")) {
        // Binary
        tmp = tmp.substring(2);
        val = parseInt(tmp, 2);
    } else if (tmp.charAt(0) === "0") {
        if (tmp === "0") {
            // Zero
            val = 0;
        } else {
            // Octal
            tmp = tmp.substring(1);
            if ((tmp.charAt(0) === "o") || (tmp.charAt(0) === "O")) {
                tmp = tmp.substring(1);
            }
            val = parseInt(tmp, 8);
        }
    }
    else {
        // Decimal
        val = parseInt(tmp, 10);
    }

    // Convert to long
    if (val > Sk.builtin.int_.threshold$ &&
        Math.floor(val) === val &&
        (s.indexOf("e") === -1 && s.indexOf("E") === -1)) {
        return Sk.longFromStr(s, 0);
    }

    // Small enough, return parsed number
    if (neg) {
        return new Sk.builtin.int_(-val);
    } else {
        return new Sk.builtin.int_(val);
    }
}

function astForSlice (c, n) {
    var n2;
    var step;
    var upper;
    var lower;
    var ch;
    REQ(n, SYM.subscript);

    /*
     subscript: '.' '.' '.' | test | [test] ':' [test] [sliceop]
     sliceop: ':' [test]
     */
    ch = CHILD(n, 0);
    lower = null;
    upper = null;
    step = null;
    if (ch.type === TOK.T_DOT) {
        return new Sk.ast.Ellipsis();
    }
    if (NCH(n) === 1 && ch.type === SYM.test) {
        return new Sk.ast.Index(ast_for_expr(c, ch));
    }
    if (ch.type === SYM.test) {
        lower = ast_for_expr(c, ch);
    }
    if (ch.type === TOK.T_COLON) {
        if (NCH(n) > 1) {
            n2 = CHILD(n, 1);
            if (n2.type === SYM.test) {
                upper = ast_for_expr(c, n2);
            }
        }
    }
    else if (NCH(n) > 2) {
        n2 = CHILD(n, 2);
        if (n2.type === SYM.test) {
            upper = ast_for_expr(c, n2);
        }
    }

    ch = CHILD(n, NCH(n) - 1);
    if (ch.type === SYM.sliceop) {
        if (NCH(ch) === 1) {
            ch = CHILD(ch, 0);
            step = new Sk.ast.Name(strobj("None"), Sk.ast.Load, ch.lineno, ch.col_offset);
        }
        else {
            ch = CHILD(ch, 1);
            if (ch.type === SYM.test) {
                step = ast_for_expr(c, ch);
            }
        }
    }
    return new Sk.ast.Slice(lower, upper, step);
}

function ast_for_atom(c, n)
{
    /* atom: '(' [yield_expr|testlist_comp] ')' | '[' [testlist_comp] ']'
       | '{' [dictmaker|testlist_comp] '}' | NAME | NUMBER | STRING+
       | '...' | 'None' | 'True' | 'False'
    */
    var ch = CHILD(n, 0);

    switch (TYPE(ch)) {
        case TOK.T_NAME: {
            var name;
            var s = STR(ch);
            if (s.length >= 4 && s.length <= 5) {
                if (s === "None") {
                    return new Sk.ast.NameConstant(Sk.builtin.none.none$, n.lineno, n.col_offset);
                }

                if (s === "True") {
                    return new Sk.ast.NameConstant(Sk.builtin.bool.true$, n.lineno, n.col_offset);
                }

                if (s === "False") {
                    return new Sk.ast.NameConstant(Sk.builtin.bool.false$, n.lineno, n.col_offset);
                }
            }
            name = new_identifier(s, c);
            /* All names start in Load context, but may later be changed. */
            return new Sk.ast.Name(name, Sk.ast.Load, LINENO(n), n.col_offset,
                        n.end_lineno, n.end_col_offset);
        }
        case TOK.T_STRING: {
            var str = parsestrplus(c, n);
            // if (!str) {
            //     const char *errtype = NULL;
            //     if (PyErr_ExceptionMatches(PyExc_UnicodeError))
            //         errtype = "unicode error";
            //     else if (PyErr_ExceptionMatches(PyExc_ValueError))
            //         errtype = "value error";
            //     if (errtype) {
            //         PyObject *type, *value, *tback, *errstr;
            //         PyErr_Fetch(&type, &value, &tback);
            //         errstr = PyObject_Str(value);
            //         if (errstr) {
            //             ast_error(c, n, "(%s) %U", errtype, errstr);
            //             Py_DECREF(errstr);
            //         }
            //         else {
            //             PyErr_Clear();
            //             ast_error(c, n, "(%s) unknown error", errtype);
            //         }
            //         Py_DECREF(type);
            //         Py_XDECREF(value);
            //         Py_XDECREF(tback);
            //     }
            //     return NULL;
            // }
            return new Sk.ast.Str(str, LINENO(n), n.col_offset, c.end_lineno, n.end_col_offset);
        }
        case TOK.T_NUMBER:
            return new Sk.ast.Num(parsenumber(c, ch.value, n.lineno), n.lineno, n.col_offset);
        case TOK.T_ELLIPSIS: /* Ellipsis */
            return new Sk.ast.Ellipsis(LINENO(n), n.col_offset,
                            n.end_lineno, n.end_col_offset);
        case TOK.T_LPAR: /* some parenthesized expressions */
            ch = CHILD(n, 1);

            if (TYPE(ch) == TOK.T_RPAR)
                return new Sk.ast.Tuple([], Sk.ast.Load, LINENO(n), n.col_offset,
                            n.end_lineno, n.end_col_offset);

            if (TYPE(ch) == SYM.yield_expr) {
                return ast_for_expr(c, ch);
            }

            /* testlist_comp: test ( comp_for | (',' test)* [','] ) */
            if (NCH(ch) == 1) {
                return ast_for_testlist(c, ch);
            }

            if (TYPE(CHILD(ch, 1)) == SYM.comp_for) {
                return copy_location(ast_for_genexp(c, ch), n);
            }
            else {
                return copy_location(ast_for_testlist(c, ch), n);
            }
        case TOK.T_LSQB: /* list (or list comprehension) */
            ch = CHILD(n, 1);

            if (TYPE(ch) == TOK.T_RSQB)
                return new Sk.ast.List([], Sk.ast.Load, LINENO(n), n.col_offset,
                            n.end_lineno, n.end_col_offset);

            REQ(ch, SYM.testlist_comp);
            if (NCH(ch) == 1 || TYPE(CHILD(ch, 1)) == TOK.T_COMMA) {
                var elts = seq_for_testlist(c, ch);
                if (!elts) {
                    return null;
                }
                return new Sk.ast.List(elts, Sk.ast.Load, LINENO(n), n.col_offset,
                            n.end_lineno, n.end_col_offset);
            }
            else {
                return copy_location(ast_for_listcomp(c, ch), n);
            }
        case TOK.T_LBRACE: {
            /* dictorsetmaker: ( ((test ':' test | '**' test)
            *                    (comp_for | (',' (test ':' test | '**' test))* [','])) |
            *                   ((test | '*' test)
            *                    (comp_for | (',' (test | '*' test))* [','])) ) */
            var res;
            ch = CHILD(n, 1);
            if (TYPE(ch) == TOK.T_RBRACE) {
                /* It's an empty dict. */
                return new Sk.ast.Dict(null, null, LINENO(n), n.col_offset, 
                    n.end_lineno, n.end_col_offset);
            }
            else {
                var is_dict = (TYPE(CHILD(ch, 0)) == TOK.T_DOUBLESTAR);
                if (NCH(ch) == 1 ||
                        (NCH(ch) > 1 &&
                        TYPE(CHILD(ch, 1)) == TOK.T_COMMA)) {
                    /* It's a set display. */
                    res = ast_for_setdisplay(c, ch);
                }
                else if (NCH(ch) > 1 &&
                        TYPE(CHILD(ch, 1)) == SYM.comp_for) {
                    /* It's a set comprehension. */
                    res = ast_for_setcomp(c, ch);
                }
                else if (NCH(ch) > 3 - is_dict &&
                        TYPE(CHILD(ch, 3 - is_dict)) == SYM.comp_for) {
                    /* It's a dictionary comprehension. */
                    if (is_dict) {
                        ast_error(c, n,
                                "dict unpacking cannot be used in dict comprehension");
                        return null;
                    }
                    res = ast_for_dictcomp(c, ch);
                }
                else {
                    /* It's a dictionary display. */
                    res = ast_for_dictdisplay(c, ch);
                }
                return copy_location(res, n);
            }
        }
        default:
            goog.assert.fail("unhandled atom " + TYPE(ch));
            return null;
    }
}

function astForAtom(c, n) {
    /* atom: '(' [yield_expr|testlist_comp] ')' | '[' [testlist_comp] ']'
       | '{' [dictmaker|testlist_comp] '}' | NAME | NUMBER | STRING+
       | '...' | 'None' | 'True' | 'False'
    */
    var i;
    var values;
    var keys;
    var size;
    var ch = CHILD(n, 0);
    var elts;
    switch (ch.type) {
        case TOK.T_NAME:
            var s = ch.value;
            // All names start in Load context, but may be changed later
            if (s.length >= 4 && s.length <= 5) {
                if (s === "None") {
                    return new Sk.ast.NameConstant(Sk.builtin.none.none$, n.lineno, n.col_offset /* c.c_arena*/);
                }

                if (s === "True") {
                    return new Sk.ast.NameConstant(Sk.builtin.bool.true$, n.lineno, n.col_offset /* c.c_arena*/);
                }

                if (s === "False") {
                    return new Sk.ast.NameConstant(Sk.builtin.bool.false$, n.lineno, n.col_offset /* c.c_arena*/);
                }

            }
            var name = new_identifier(s, c)

            /* All names start in Load context, but may later be changed. */
            return new Sk.ast.Name(name, Sk.ast.Load, n.lineno, n.col_offset);
        case TOK.T_STRING:
            return new Sk.ast.Str(parsestrplus(c, n), n.lineno, n.col_offset);
        case TOK.T_NUMBER:
            return new Sk.ast.Num(parsenumber(c, ch.value, n.lineno), n.lineno, n.col_offset);
        case TOK.T_LPAR: // various uses for parens
            ch = CHILD(n, 1);
            if (ch.type === TOK.T_RPAR) {
                return new Sk.ast.Tuple([], Sk.ast.Load, n.lineno, n.col_offset);
            }
            if (ch.type === SYM.yield_expr) {
                return ast_for_expr(c, ch);
            }
            //            if (NCH(ch) > 1 && CHILD(ch, 1).type === SYM.comp_for) {
            //                return astForComprehension(c, ch);
            //            }
            return ast_for_testlistComp(c, ch);
        case TOK.T_LSQB: // list or listcomp
            ch = CHILD(n, 1);
            if (ch.type === TOK.T_RSQB) {
                return new Sk.ast.List([], Sk.ast.Load, n.lineno, n.col_offset);
            }
            REQ(ch, SYM.listmaker);
            if (NCH(ch) === 1 || CHILD(ch, 1).type === TOK.T_COMMA) {
                return new Sk.ast.List(seq_for_testlist(c, ch), Sk.ast.Load, n.lineno, n.col_offset);
            }
            return ast_for_listcomp(c, ch);

        case TOK.T_LBRACE:
            /* dictorsetmaker:
             *     (test ':' test (comp_for : (',' test ':' test)* [','])) |
             *     (test (comp_for | (',' test)* [',']))
             */
            keys = [];
            values = [];
            ch = CHILD(n, 1);
            if (n.type === TOK.T_RBRACE) {
                //it's an empty dict
                return new Sk.ast.Dict([], null, n.lineno, n.col_offset);
            }
            else if (NCH(ch) === 1 || (NCH(ch) !== 0 && CHILD(ch, 1).type === TOK.T_COMMA)) {
                //it's a simple set
                elts = [];
                size = Math.floor((NCH(ch) + 1) / 2);
                for (i = 0; i < NCH(ch); i += 2) {
                    var expression = ast_for_expr(c, CHILD(ch, i));
                    elts[i / 2] = expression;
                }
                return new Sk.ast.Set(elts, n.lineno, n.col_offset);
            }
            else if (NCH(ch) !== 0 && CHILD(ch, 1).type == SYM.comp_for) {
                //it's a set comprehension
                return ast_for_setcomp(c, ch);
            }
            else if (NCH(ch) > 3 && CHILD(ch, 3).type === SYM.comp_for) {
                //it's a dict compr. I think.
                return ast_for_dictcomp(c, ch);
            }
            else {
                size = Math.floor((NCH(ch) + 1) / 4); // + 1 for no trailing comma case
                for (i = 0; i < NCH(ch); i += 4) {
                    keys[i / 4] = ast_for_expr(c, CHILD(ch, i));
                    values[i / 4] = ast_for_expr(c, CHILD(ch, i + 2));
                }
                return new Sk.ast.Dict(keys, values, n.lineno, n.col_offset);
            }
        case TOK.T_BACKQUOTE:
            //throw new Sk.builtin.SyntaxError("backquote not supported, use repr()", c.c_filename, n.lineno);
            return new Sk.ast.Repr(ast_for_testlist(c, CHILD(n, 1)), n.lineno, n.col_offset);
        default:
            goog.asserts.fail("unhandled atom", ch.type);

    }
}

function astForAtomExpr(c, n) {
    var i, nch, start = 0;
    var e, tmp;

    REQ(n, SYM.atom_expr);
    nch = NCH(n);

    if (CHILD(n, 0).type === TOK.T_AWAIT) {
        start = 1;
        goog.asserts.assert(nch > 1);
    }

    e = ast_for_atom(c, CHILD(n, start));
    if (!e) {
        return null;
    }

    if (nch === 1) {
        return e;
    }

    if (start && nch === 2) {
        return new Sk.ast.Await(e, n.lineno, n.col_offset /*, c->c_arena*/);
    }

    for (i = start + 1; i < nch; i++) {
        var ch = CHILD(n, i);
        if (ch.type !== SYM.trailer) {
            break;
        }
        tmp = ast_for_trailer(c, ch, e);
        if (!tmp) {
            return null;
        }

        tmp.lineno = e.lineno;
        tmp.col_offset = e.col_offset;
        e = tmp;
    }

    if (start) {
        /* there was an AWAIT */
        return new Sk.ast.Await(e, n.line, n.col_offset /*, c->c_arena*/);
    }
    else {
        return e;
    }
}

function astForPower (c, n) {
    /* power: atom trailer* ('**' factor)*
     */
    var f;
    var tmp;
    var ch;
    var i;
    var e;
    REQ(n, SYM.power);
    e = astForAtomExpr(c, CHILD(n, 0));
    if (NCH(n) === 1) {
        return e;
    }
    if (CHILD(n, NCH(n) - 1).type === SYM.factor) {
        f = ast_for_expr(c, CHILD(n, NCH(n) - 1));
        e = new Sk.ast.BinOp(e, Sk.ast.Pow, f, n.lineno, n.col_offset);
    }
    return e;
}

function astForStarred(c, n) {
    REQ(n, SYM.star_expr);

    /* The Load context is changed later */
    return new Sk.ast.Starred(ast_for_expr(c, CHILD(n ,1)), Sk.ast.Load, n.lineno, n.col_offset /*, c.c_arena */)
}

function ast_for_expr (c, n) {
    /*
     handle the full range of simple expressions
     test: or_test ['if' or_test 'else' test] | lambdef
     test_nocond: or_test | lambdef_nocond
     or_test: and_test ('or' and_test)*
     and_test: not_test ('and' not_test)*
     not_test: 'not' not_test | comparison
     comparison: expr (comp_op expr)*
     expr: xor_expr ('|' xor_expr)*
     xor_expr: and_expr ('^' and_expr)*
     and_expr: shift_expr ('&' shift_expr)*
     shift_expr: arith_expr (('<<'|'>>') arith_expr)*
     arith_expr: term (('+'|'-') term)*
     term: factor (('*'|'/'|'%'|'//') factor)*
     factor: ('+'|'-'|'~') factor | power
     power: atom_expr ['**' factor]
     atom_expr: [AWAIT] atom trailer*
     yield_expr: 'yield' [yield_arg]
    */

    var exp;
    var cmps;
    var ops;
    var i;
    var seq;
    LOOP: while (true) {
        switch (n.type) {
            case SYM.test:
            case SYM.test_nocond:
                if (CHILD(n, 0).type === SYM.lambdef || CHILD(n, 0).type === SYM.lambdef_nocond) {
                    return astForLambdef(c, CHILD(n, 0));
                }
                else if (NCH(n) > 1) {
                    return astForIfexpr(c, n);
                }
                // fallthrough
            case SYM.or_test:
            case SYM.and_test:
                if (NCH(n) === 1) {
                    n = CHILD(n, 0);
                    continue LOOP;
                }
                seq = [];
                for (i = 0; i < NCH(n); i += 2) {
                    seq[i / 2] = ast_for_expr(c, CHILD(n, i));
                }
                if (CHILD(n, 1).value === "and") {
                    return new Sk.ast.BoolOp(Sk.ast.And, seq, n.lineno, n.col_offset /*, c.c_arena*/);
                }
                goog.asserts.assert(CHILD(n, 1).value === "or");
                return new Sk.ast.BoolOp(Sk.ast.Or, seq, n.lineno, n.col_offset);
            case SYM.not_test:
                if (NCH(n) === 1) {
                    n = CHILD(n, 0);
                    continue LOOP;
                }
                else {
                    return new Sk.ast.UnaryOp(Sk.ast.Not, ast_for_expr(c, CHILD(n, 1)), n.lineno, n.col_offset);
                }
                break;
            case SYM.comparison:
                if (NCH(n) === 1) {
                    n = CHILD(n, 0);
                    continue LOOP;
                }
                else {
                    ops = [];
                    cmps = [];
                    for (i = 1; i < NCH(n); i += 2) {
                        ops[(i - 1) / 2] = astForCompOp(c, CHILD(n, i));
                        cmps[(i - 1) / 2] = ast_for_expr(c, CHILD(n, i + 1));
                    }
                    return new Sk.ast.Compare(ast_for_expr(c, CHILD(n, 0)), ops, cmps, n.lineno, n.col_offset);
                }
                break;
            case SYM.star_expr:
                return astForStarred(c, n);
            /* The next fize cases all handle BinOps  The main body of code
               is the same in each case, but the switch turned inside out to
               reuse the code for each type of operator
             */
            case SYM.expr:
            case SYM.xor_expr:
            case SYM.and_expr:
            case SYM.shift_expr:
            case SYM.arith_expr:
            case SYM.term:
                if (NCH(n) === 1) {
                    n = CHILD(n, 0);
                    continue LOOP;
                }
                return astForBinop(c, n);
            case SYM.yield_expr:
                var an;
                var en
                var is_from = false;
                exp = null;
                if (NCH(n) > 1) {
                    an = CHILD(n, 1); /* yield_arg */
                }

                if (an) {
                    en = CHILD(an, NCH(an) - 1);
                    if (NCH(an) == 2) {
                        is_from = true;
                        exp = ast_for_expr(c, en);
                    } else {
                        exp = ast_for_testlist(c, en);
                    }
                }

                if (is_from) {
                    return new Sk.ast.YieldFrom(exp, n.lineno, n.col_offset);
                }

                return new Sk.ast.Yield(exp, n.lineno, n.col_offset);
            case SYM.factor:
                if (NCH(n) === 1) {
                    n = CHILD(n, 0);
                    continue LOOP;
                }
                return astForFactor(c, n);
            case SYM.power:
                return astForPower(c, n);
            default:
                goog.asserts.fail("unhandled expr", "n.type: %d", n.type);
        }
        break;
    }
}

function astForNonLocalStmt(c, n) {
    ast_error(c, n, "Not implemented: nonlocal");
}

function astForAsyncStmt(c, n) {
    ast_error(c, n, "Not implemented: async");
}

// This is only used for Python 2 support.
// TODO we should have something in c.c_flags
// gating whether this is permissible or a SyntaxError
function astForPrintStmt (c, n) {
    /* print_stmt: 'print' ( [ test (',' test)* [','] ]
     | '>>' test [ (',' test)+ [','] ] )
     */
    var nl;
    var i, j;
    var seq;
    var start = 1;
    var dest = null;
    REQ(n, SYM.print_stmt);
    if (NCH(n) >= 2 && CHILD(n, 1).type === TOK.T_RIGHTSHIFT) {
        dest = ast_for_expr(c, CHILD(n, 2));
        start = 4;
    }
    seq = [];
    for (i = start, j = 0; i < NCH(n); i += 2, ++j) {
        seq[j] = ast_for_expr(c, CHILD(n, i));
    }
    nl = (CHILD(n, NCH(n) - 1)).type === TOK.T_COMMA ? false : true;
    return new Sk.ast.Print(dest, seq, nl, n.lineno, n.col_offset);
}

function astForStmt (c, n) {
    var ch;
    if (n.type === SYM.stmt) {
        goog.asserts.assert(NCH(n) === 1);
        n = CHILD(n, 0);
    }
    if (n.type === SYM.simple_stmt) {
        goog.asserts.assert(numStmts(n) === 1);
        n = CHILD(n, 0);
    }
    if (n.type === SYM.small_stmt) {
        n = CHILD(n, 0);
        /* small_stmt: expr_stmt | del_stmt | pass_stmt | flow_stmt
                   | import_stmt | global_stmt | nonlocal_stmt | assert_stmt
                   | debugger_stmt (skulpt special)
        */
        switch (n.type) {
            case SYM.expr_stmt:
                return ast_for_exprStmt(c, n);
            case SYM.del_stmt:
                return astForDelStmt(c, n);
            case SYM.pass_stmt:
                return new Sk.ast.Pass(n.lineno, n.col_offset);
            case SYM.flow_stmt:
                return ast_for_flow_stmt(c, n);
            case SYM.import_stmt:
                return astForImportStmt(c, n);
            case SYM.global_stmt:
                return astForGlobalStmt(c, n);
            case SYM.nonlocal_stmt:
                return astForNonLocalStmt(c, n);
            case SYM.assert_stmt:
                return astForAssertStmt(c, n);
            // TODO this should both be gated behind a __future__ flag
            case SYM.print_stmt:
                return astForPrintStmt(c, n);
            case SYM.debugger_stmt:
                return new Sk.ast.Debugger(n.lineno, n.col_offset);
            default:
                goog.asserts.fail("unhandled small_stmt");
        }
    }
    else {
        /* compound_stmt: if_stmt | while_stmt | for_stmt | try_stmt
                        | funcdef | classdef | decorated | async_stmt
        */
        ch = CHILD(n, 0);
        REQ(n, SYM.compound_stmt);
        switch (ch.type) {
            case SYM.if_stmt:
                return astForIfStmt(c, ch);
            case SYM.while_stmt:
                return astForWhileStmt(c, ch);
            case SYM.for_stmt:
                return astForForStmt(c, ch);
            case SYM.try_stmt:
                return astForTryStmt(c, ch);
            case SYM.with_stmt:
                return astForWithStmt(c, ch);
            case SYM.funcdef:
                return astForFuncdef(c, ch, []);
            case SYM.classdef:
                return astForClassdef(c, ch, []);
            case SYM.decorated:
                return astForDecorated(c, ch);
            case SYM.async_stmt:
                return astForAsyncStmt(c, ch);
            default:
                goog.asserts.assert("unhandled compound_stmt");
        }
    }
};

Sk.astFromParse = function (n, filename, c_flags) {
    var j;
    var num;
    var ch;
    var i;
    var c = new Compiling("utf-8", filename, c_flags);
    var stmts = [];
    var k = 0;
    switch (n.type) {
        case SYM.file_input:
            for (i = 0; i < NCH(n) - 1; ++i) {
                ch = CHILD(n, i);
                if (n.type === TOK.T_NEWLINE) {
                    continue;
                }
                REQ(ch, SYM.stmt);
                num = numStmts(ch);
                if (num === 1) {
                    stmts[k++] = astForStmt(c, ch);
                }
                else {
                    ch = CHILD(ch, 0);
                    REQ(ch, SYM.simple_stmt);
                    for (j = 0; j < num; ++j) {
                        stmts[k++] = astForStmt(c, CHILD(ch, j * 2));
                    }
                }
            }
            return new Sk.ast.Module(stmts);
        case SYM.eval_input:
            goog.asserts.fail("todo;");
        case SYM.single_input:
            goog.asserts.fail("todo;");
        default:
            goog.asserts.fail("todo;");
    }
};

Sk.astDump = function (node) {
    var spaces = function (n) // todo; blurgh
    {
        var i;
        var ret = "";
        for (i = 0; i < n; ++i) {
            ret += " ";
        }
        return ret;
    };

    var _format = function (node, indent) {
        var ret;
        var elemsstr;
        var x;
        var elems;
        var fieldstr;
        var field;
        var attrs;
        var fieldlen;
        var b;
        var a;
        var i;
        var fields;
        var namelen;
        if (node === null) {
            return indent + "None";
        }
        else if (node.prototype && node.prototype._astname !== undefined && node.prototype._isenum) {
            return indent + node.prototype._astname + "()";
        }
        else if (node._astname !== undefined) {
            namelen = spaces(node._astname.length + 1);
            fields = [];
            for (i = 0; i < node._fields.length; i += 2) // iter_fields
            {
                a = node._fields[i]; // field name
                b = node._fields[i + 1](node); // field getter func
                fieldlen = spaces(a.length + 1);
                fields.push([a, _format(b, indent + namelen + fieldlen)]);
            }
            attrs = [];
            for (i = 0; i < fields.length; ++i) {
                field = fields[i];
                attrs.push(field[0] + "=" + field[1].replace(/^\s+/, ""));
            }
            fieldstr = attrs.join(",\n" + indent + namelen);
            return indent + node._astname + "(" + fieldstr + ")";
        }
        else if (goog.isArrayLike(node)) {
            //Sk.debugout("arr", node.length);
            elems = [];
            for (i = 0; i < node.length; ++i) {
                x = node[i];
                elems.push(_format(x, indent + " "));
            }
            elemsstr = elems.join(",\n");
            return indent + "[" + elemsstr.replace(/^\s+/, "") + "]";
        }
        else {
            if (node === true) {
                ret = "True";
            }
            else if (node === false) {
                ret = "False";
            }
            else if (node instanceof Sk.builtin.lng) {
                ret = node.tp$str().v;
            }
            else if (node instanceof Sk.builtin.str) {
                ret = node["$r"]().v;
            }
            else {
                ret = "" + node;
            }
            return indent + ret;
        }
    };

    return _format(node, "");
};

goog.exportSymbol("Sk.astFromParse", Sk.astFromParse);
goog.exportSymbol("Sk.astDump", Sk.astDump);
