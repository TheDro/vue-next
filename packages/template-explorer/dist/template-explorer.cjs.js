'use strict';

var parser = require('@babel/parser');
var estreeWalker = require('estree-walker');
var sourceMap = require('source-map');

/**
 * Make a map and return a function for checking if a key
 * is in that map.
 * IMPORTANT: all calls of this function must be prefixed with
 * \/\*#\_\_PURE\_\_\*\/
 * So that rollup can tree-shake them if necessary.
 */
function makeMap(str, expectsLowerCase) {
    const map = Object.create(null);
    const list = str.split(',');
    for (let i = 0; i < list.length; i++) {
        map[list[i]] = true;
    }
    return expectsLowerCase ? val => !!map[val.toLowerCase()] : val => !!map[val];
}

/**
 * dev only flag -> name mapping
 */
const PatchFlagNames = {
    [1 /* TEXT */]: `TEXT`,
    [2 /* CLASS */]: `CLASS`,
    [4 /* STYLE */]: `STYLE`,
    [8 /* PROPS */]: `PROPS`,
    [16 /* FULL_PROPS */]: `FULL_PROPS`,
    [32 /* HYDRATE_EVENTS */]: `HYDRATE_EVENTS`,
    [64 /* STABLE_FRAGMENT */]: `STABLE_FRAGMENT`,
    [128 /* KEYED_FRAGMENT */]: `KEYED_FRAGMENT`,
    [256 /* UNKEYED_FRAGMENT */]: `UNKEYED_FRAGMENT`,
    [512 /* NEED_PATCH */]: `NEED_PATCH`,
    [1024 /* DYNAMIC_SLOTS */]: `DYNAMIC_SLOTS`,
    [2048 /* DEV_ROOT_FRAGMENT */]: `DEV_ROOT_FRAGMENT`,
    [-1 /* HOISTED */]: `HOISTED`,
    [-2 /* BAIL */]: `BAIL`
};

/**
 * Dev only
 */
const slotFlagsText = {
    [1 /* STABLE */]: 'STABLE',
    [2 /* DYNAMIC */]: 'DYNAMIC',
    [3 /* FORWARDED */]: 'FORWARDED'
};

const GLOBALS_WHITE_LISTED = 'Infinity,undefined,NaN,isFinite,isNaN,parseFloat,parseInt,decodeURI,' +
    'decodeURIComponent,encodeURI,encodeURIComponent,Math,Number,Date,Array,' +
    'Object,Boolean,String,RegExp,Map,Set,JSON,Intl,BigInt';
const isGloballyWhitelisted = /*#__PURE__*/ makeMap(GLOBALS_WHITE_LISTED);

/**
 * On the client we only need to offer special cases for boolean attributes that
 * have different names from their corresponding dom properties:
 * - itemscope -> N/A
 * - allowfullscreen -> allowFullscreen
 * - formnovalidate -> formNoValidate
 * - ismap -> isMap
 * - nomodule -> noModule
 * - novalidate -> noValidate
 * - readonly -> readOnly
 */
const specialBooleanAttrs = `itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,readonly`;
const isSpecialBooleanAttr = /*#__PURE__*/ makeMap(specialBooleanAttrs);
/**
 * The full list is needed during SSR to produce the correct initial markup.
 */
const isBooleanAttr = /*#__PURE__*/ makeMap(specialBooleanAttrs +
    `,async,autofocus,autoplay,controls,default,defer,disabled,hidden,` +
    `loop,open,required,reversed,scoped,seamless,` +
    `checked,muted,multiple,selected`);
const unsafeAttrCharRE = /[>/="'\u0009\u000a\u000c\u0020]/;
const attrValidationCache = {};
function isSSRSafeAttrName(name) {
    if (attrValidationCache.hasOwnProperty(name)) {
        return attrValidationCache[name];
    }
    const isUnsafe = unsafeAttrCharRE.test(name);
    if (isUnsafe) {
        console.error(`unsafe attribute name: ${name}`);
    }
    return (attrValidationCache[name] = !isUnsafe);
}
const propsToAttrMap = {
    acceptCharset: 'accept-charset',
    className: 'class',
    htmlFor: 'for',
    httpEquiv: 'http-equiv'
};
/**
 * CSS properties that accept plain numbers
 */
const isNoUnitNumericStyleProp = /*#__PURE__*/ makeMap(`animation-iteration-count,border-image-outset,border-image-slice,` +
    `border-image-width,box-flex,box-flex-group,box-ordinal-group,column-count,` +
    `columns,flex,flex-grow,flex-positive,flex-shrink,flex-negative,flex-order,` +
    `grid-row,grid-row-end,grid-row-span,grid-row-start,grid-column,` +
    `grid-column-end,grid-column-span,grid-column-start,font-weight,line-clamp,` +
    `line-height,opacity,order,orphans,tab-size,widows,z-index,zoom,` +
    // SVG
    `fill-opacity,flood-opacity,stop-opacity,stroke-dasharray,stroke-dashoffset,` +
    `stroke-miterlimit,stroke-opacity,stroke-width`);
/**
 * Known attributes, this is used for stringification of runtime static nodes
 * so that we don't stringify bindings that cannot be set from HTML.
 * Don't also forget to allow `data-*` and `aria-*`!
 * Generated from https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes
 */
const isKnownAttr = /*#__PURE__*/ makeMap(`accept,accept-charset,accesskey,action,align,allow,alt,async,` +
    `autocapitalize,autocomplete,autofocus,autoplay,background,bgcolor,` +
    `border,buffered,capture,challenge,charset,checked,cite,class,code,` +
    `codebase,color,cols,colspan,content,contenteditable,contextmenu,controls,` +
    `coords,crossorigin,csp,data,datetime,decoding,default,defer,dir,dirname,` +
    `disabled,download,draggable,dropzone,enctype,enterkeyhint,for,form,` +
    `formaction,formenctype,formmethod,formnovalidate,formtarget,headers,` +
    `height,hidden,high,href,hreflang,http-equiv,icon,id,importance,integrity,` +
    `ismap,itemprop,keytype,kind,label,lang,language,loading,list,loop,low,` +
    `manifest,max,maxlength,minlength,media,min,multiple,muted,name,novalidate,` +
    `open,optimum,pattern,ping,placeholder,poster,preload,radiogroup,readonly,` +
    `referrerpolicy,rel,required,reversed,rows,rowspan,sandbox,scope,scoped,` +
    `selected,shape,size,sizes,slot,span,spellcheck,src,srcdoc,srclang,srcset,` +
    `start,step,style,summary,tabindex,target,title,translate,type,usemap,` +
    `value,width,wrap`);

function normalizeStyle(value) {
    if (isArray(value)) {
        const res = {};
        for (let i = 0; i < value.length; i++) {
            const item = value[i];
            const normalized = normalizeStyle(isString(item) ? parseStringStyle(item) : item);
            if (normalized) {
                for (const key in normalized) {
                    res[key] = normalized[key];
                }
            }
        }
        return res;
    }
    else if (isObject(value)) {
        return value;
    }
}
const listDelimiterRE = /;(?![^(]*\))/g;
const propertyDelimiterRE = /:(.+)/;
function parseStringStyle(cssText) {
    const ret = {};
    cssText.split(listDelimiterRE).forEach(item => {
        if (item) {
            const tmp = item.split(propertyDelimiterRE);
            tmp.length > 1 && (ret[tmp[0].trim()] = tmp[1].trim());
        }
    });
    return ret;
}
function stringifyStyle(styles) {
    let ret = '';
    if (!styles) {
        return ret;
    }
    for (const key in styles) {
        const value = styles[key];
        const normalizedKey = key.startsWith(`--`) ? key : hyphenate(key);
        if (isString(value) ||
            (typeof value === 'number' && isNoUnitNumericStyleProp(normalizedKey))) {
            // only render valid values
            ret += `${normalizedKey}:${value};`;
        }
    }
    return ret;
}
function normalizeClass(value) {
    let res = '';
    if (isString(value)) {
        res = value;
    }
    else if (isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const normalized = normalizeClass(value[i]);
            if (normalized) {
                res += normalized + ' ';
            }
        }
    }
    else if (isObject(value)) {
        for (const name in value) {
            if (value[name]) {
                res += name + ' ';
            }
        }
    }
    return res.trim();
}

// These tag configs are shared between compiler-dom and runtime-dom, so they
// https://developer.mozilla.org/en-US/docs/Web/HTML/Element
const HTML_TAGS = 'html,body,base,head,link,meta,style,title,address,article,aside,footer,' +
    'header,h1,h2,h3,h4,h5,h6,hgroup,nav,section,div,dd,dl,dt,figcaption,' +
    'figure,picture,hr,img,li,main,ol,p,pre,ul,a,b,abbr,bdi,bdo,br,cite,code,' +
    'data,dfn,em,i,kbd,mark,q,rp,rt,rtc,ruby,s,samp,small,span,strong,sub,sup,' +
    'time,u,var,wbr,area,audio,map,track,video,embed,object,param,source,' +
    'canvas,script,noscript,del,ins,caption,col,colgroup,table,thead,tbody,td,' +
    'th,tr,button,datalist,fieldset,form,input,label,legend,meter,optgroup,' +
    'option,output,progress,select,textarea,details,dialog,menu,' +
    'summary,template,blockquote,iframe,tfoot';
// https://developer.mozilla.org/en-US/docs/Web/SVG/Element
const SVG_TAGS = 'svg,animate,animateMotion,animateTransform,circle,clipPath,color-profile,' +
    'defs,desc,discard,ellipse,feBlend,feColorMatrix,feComponentTransfer,' +
    'feComposite,feConvolveMatrix,feDiffuseLighting,feDisplacementMap,' +
    'feDistanceLight,feDropShadow,feFlood,feFuncA,feFuncB,feFuncG,feFuncR,' +
    'feGaussianBlur,feImage,feMerge,feMergeNode,feMorphology,feOffset,' +
    'fePointLight,feSpecularLighting,feSpotLight,feTile,feTurbulence,filter,' +
    'foreignObject,g,hatch,hatchpath,image,line,linearGradient,marker,mask,' +
    'mesh,meshgradient,meshpatch,meshrow,metadata,mpath,path,pattern,' +
    'polygon,polyline,radialGradient,rect,set,solidcolor,stop,switch,symbol,' +
    'text,textPath,title,tspan,unknown,use,view';
const VOID_TAGS = 'area,base,br,col,embed,hr,img,input,link,meta,param,source,track,wbr';
const isHTMLTag = /*#__PURE__*/ makeMap(HTML_TAGS);
const isSVGTag = /*#__PURE__*/ makeMap(SVG_TAGS);
const isVoidTag = /*#__PURE__*/ makeMap(VOID_TAGS);

const escapeRE = /["'&<>]/;
function escapeHtml(string) {
    const str = '' + string;
    const match = escapeRE.exec(str);
    if (!match) {
        return str;
    }
    let html = '';
    let escaped;
    let index;
    let lastIndex = 0;
    for (index = match.index; index < str.length; index++) {
        switch (str.charCodeAt(index)) {
            case 34: // "
                escaped = '&quot;';
                break;
            case 38: // &
                escaped = '&amp;';
                break;
            case 39: // '
                escaped = '&#39;';
                break;
            case 60: // <
                escaped = '&lt;';
                break;
            case 62: // >
                escaped = '&gt;';
                break;
            default:
                continue;
        }
        if (lastIndex !== index) {
            html += str.substring(lastIndex, index);
        }
        lastIndex = index + 1;
        html += escaped;
    }
    return lastIndex !== index ? html + str.substring(lastIndex, index) : html;
}

/**
 * For converting {{ interpolation }} values to displayed strings.
 * @private
 */
const toDisplayString = (val) => {
    return val == null
        ? ''
        : isObject(val)
            ? JSON.stringify(val, replacer, 2)
            : String(val);
};
const replacer = (_key, val) => {
    if (isMap(val)) {
        return {
            [`Map(${val.size})`]: [...val.entries()].reduce((entries, [key, val]) => {
                entries[`${key} =>`] = val;
                return entries;
            }, {})
        };
    }
    else if (isSet(val)) {
        return {
            [`Set(${val.size})`]: [...val.values()]
        };
    }
    else if (isObject(val) && !isArray(val) && !isPlainObject(val)) {
        return String(val);
    }
    return val;
};

/**
 * List of @babel/parser plugins that are used for template expression
 * transforms and SFC script transforms. By default we enable proposals slated
 * for ES2020. This will need to be updated as the spec moves forward.
 * Full list at https://babeljs.io/docs/en/next/babel-parser#plugins
 */
const babelParserDefaultPlugins = [
    'bigInt',
    'optionalChaining',
    'nullishCoalescingOperator'
];
const EMPTY_OBJ = Object.freeze({})
    ;
const EMPTY_ARR = Object.freeze([]) ;
const NOOP = () => { };
/**
 * Always return false.
 */
const NO = () => false;
const onRE = /^on[^a-z]/;
const isOn = (key) => onRE.test(key);
const isModelListener = (key) => key.startsWith('onUpdate:');
const extend = Object.assign;
const remove = (arr, el) => {
    const i = arr.indexOf(el);
    if (i > -1) {
        arr.splice(i, 1);
    }
};
const hasOwnProperty = Object.prototype.hasOwnProperty;
const hasOwn = (val, key) => hasOwnProperty.call(val, key);
const isArray = Array.isArray;
const isMap = (val) => toTypeString(val) === '[object Map]';
const isSet = (val) => toTypeString(val) === '[object Set]';
const isFunction = (val) => typeof val === 'function';
const isString = (val) => typeof val === 'string';
const isSymbol = (val) => typeof val === 'symbol';
const isObject = (val) => val !== null && typeof val === 'object';
const isPromise = (val) => {
    return isObject(val) && isFunction(val.then) && isFunction(val.catch);
};
const objectToString = Object.prototype.toString;
const toTypeString = (value) => objectToString.call(value);
const toRawType = (value) => {
    // extract "RawType" from strings like "[object RawType]"
    return toTypeString(value).slice(8, -1);
};
const isPlainObject = (val) => toTypeString(val) === '[object Object]';
const isIntegerKey = (key) => isString(key) &&
    key !== 'NaN' &&
    key[0] !== '-' &&
    '' + parseInt(key, 10) === key;
const isReservedProp = /*#__PURE__*/ makeMap(
// the leading comma is intentional so empty string "" is also included
',key,ref,' +
    'onVnodeBeforeMount,onVnodeMounted,' +
    'onVnodeBeforeUpdate,onVnodeUpdated,' +
    'onVnodeBeforeUnmount,onVnodeUnmounted');
const cacheStringFunction = (fn) => {
    const cache = Object.create(null);
    return ((str) => {
        const hit = cache[str];
        return hit || (cache[str] = fn(str));
    });
};
const camelizeRE = /-(\w)/g;
/**
 * @private
 */
const camelize = cacheStringFunction((str) => {
    return str.replace(camelizeRE, (_, c) => (c ? c.toUpperCase() : ''));
});
const hyphenateRE = /\B([A-Z])/g;
/**
 * @private
 */
const hyphenate = cacheStringFunction((str) => str.replace(hyphenateRE, '-$1').toLowerCase());
/**
 * @private
 */
const capitalize = cacheStringFunction((str) => str.charAt(0).toUpperCase() + str.slice(1));
/**
 * @private
 */
const toHandlerKey = cacheStringFunction((str) => (str ? `on${capitalize(str)}` : ``));
// compare whether a value has changed, accounting for NaN.
const hasChanged = (value, oldValue) => value !== oldValue && (value === value || oldValue === oldValue);
const invokeArrayFns = (fns, arg) => {
    for (let i = 0; i < fns.length; i++) {
        fns[i](arg);
    }
};
const def = (obj, key, value) => {
    Object.defineProperty(obj, key, {
        configurable: true,
        enumerable: false,
        value
    });
};
const toNumber = (val) => {
    const n = parseFloat(val);
    return isNaN(n) ? val : n;
};
let _globalThis;
const getGlobalThis = () => {
    return (_globalThis ||
        (_globalThis =
            typeof globalThis !== 'undefined'
                ? globalThis
                : typeof self !== 'undefined'
                    ? self
                    : typeof window !== 'undefined'
                        ? window
                        : typeof global !== 'undefined'
                            ? global
                            : {}));
};

function defaultOnError(error) {
    throw error;
}
function createCompilerError(code, loc, messages, additionalMessage) {
    const msg = (messages || errorMessages)[code] + (additionalMessage || ``)
        ;
    const error = new SyntaxError(String(msg));
    error.code = code;
    error.loc = loc;
    return error;
}
const errorMessages = {
    // parse errors
    [0 /* ABRUPT_CLOSING_OF_EMPTY_COMMENT */]: 'Illegal comment.',
    [1 /* CDATA_IN_HTML_CONTENT */]: 'CDATA section is allowed only in XML context.',
    [2 /* DUPLICATE_ATTRIBUTE */]: 'Duplicate attribute.',
    [3 /* END_TAG_WITH_ATTRIBUTES */]: 'End tag cannot have attributes.',
    [4 /* END_TAG_WITH_TRAILING_SOLIDUS */]: "Illegal '/' in tags.",
    [5 /* EOF_BEFORE_TAG_NAME */]: 'Unexpected EOF in tag.',
    [6 /* EOF_IN_CDATA */]: 'Unexpected EOF in CDATA section.',
    [7 /* EOF_IN_COMMENT */]: 'Unexpected EOF in comment.',
    [8 /* EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT */]: 'Unexpected EOF in script.',
    [9 /* EOF_IN_TAG */]: 'Unexpected EOF in tag.',
    [10 /* INCORRECTLY_CLOSED_COMMENT */]: 'Incorrectly closed comment.',
    [11 /* INCORRECTLY_OPENED_COMMENT */]: 'Incorrectly opened comment.',
    [12 /* INVALID_FIRST_CHARACTER_OF_TAG_NAME */]: "Illegal tag name. Use '&lt;' to print '<'.",
    [13 /* MISSING_ATTRIBUTE_VALUE */]: 'Attribute value was expected.',
    [14 /* MISSING_END_TAG_NAME */]: 'End tag name was expected.',
    [15 /* MISSING_WHITESPACE_BETWEEN_ATTRIBUTES */]: 'Whitespace was expected.',
    [16 /* NESTED_COMMENT */]: "Unexpected '<!--' in comment.",
    [17 /* UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME */]: 'Attribute name cannot contain U+0022 ("), U+0027 (\'), and U+003C (<).',
    [18 /* UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE */]: 'Unquoted attribute value cannot contain U+0022 ("), U+0027 (\'), U+003C (<), U+003D (=), and U+0060 (`).',
    [19 /* UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME */]: "Attribute name cannot start with '='.",
    [21 /* UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME */]: "'<?' is allowed only in XML context.",
    [22 /* UNEXPECTED_SOLIDUS_IN_TAG */]: "Illegal '/' in tags.",
    // Vue-specific parse errors
    [23 /* X_INVALID_END_TAG */]: 'Invalid end tag.',
    [24 /* X_MISSING_END_TAG */]: 'Element is missing end tag.',
    [25 /* X_MISSING_INTERPOLATION_END */]: 'Interpolation end sign was not found.',
    [26 /* X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END */]: 'End bracket for dynamic directive argument was not found. ' +
        'Note that dynamic directive argument cannot contain spaces.',
    // transform errors
    [27 /* X_V_IF_NO_EXPRESSION */]: `v-if/v-else-if is missing expression.`,
    [28 /* X_V_IF_SAME_KEY */]: `v-if/else branches must use unique keys.`,
    [29 /* X_V_ELSE_NO_ADJACENT_IF */]: `v-else/v-else-if has no adjacent v-if.`,
    [30 /* X_V_FOR_NO_EXPRESSION */]: `v-for is missing expression.`,
    [31 /* X_V_FOR_MALFORMED_EXPRESSION */]: `v-for has invalid expression.`,
    [32 /* X_V_FOR_TEMPLATE_KEY_PLACEMENT */]: `<template v-for> key should be placed on the <template> tag.`,
    [33 /* X_V_BIND_NO_EXPRESSION */]: `v-bind is missing expression.`,
    [34 /* X_V_ON_NO_EXPRESSION */]: `v-on is missing expression.`,
    [35 /* X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET */]: `Unexpected custom directive on <slot> outlet.`,
    [36 /* X_V_SLOT_MIXED_SLOT_USAGE */]: `Mixed v-slot usage on both the component and nested <template>.` +
        `When there are multiple named slots, all slots should use <template> ` +
        `syntax to avoid scope ambiguity.`,
    [37 /* X_V_SLOT_DUPLICATE_SLOT_NAMES */]: `Duplicate slot names found. `,
    [38 /* X_V_SLOT_EXTRANEOUS_DEFAULT_SLOT_CHILDREN */]: `Extraneous children found when component already has explicitly named ` +
        `default slot. These children will be ignored.`,
    [39 /* X_V_SLOT_MISPLACED */]: `v-slot can only be used on components or <template> tags.`,
    [40 /* X_V_MODEL_NO_EXPRESSION */]: `v-model is missing expression.`,
    [41 /* X_V_MODEL_MALFORMED_EXPRESSION */]: `v-model value must be a valid JavaScript member expression.`,
    [42 /* X_V_MODEL_ON_SCOPE_VARIABLE */]: `v-model cannot be used on v-for or v-slot scope variables because they are not writable.`,
    [43 /* X_INVALID_EXPRESSION */]: `Error parsing JavaScript expression: `,
    [44 /* X_KEEP_ALIVE_INVALID_CHILDREN */]: `<KeepAlive> expects exactly one child component.`,
    // generic errors
    [45 /* X_PREFIX_ID_NOT_SUPPORTED */]: `"prefixIdentifiers" option is not supported in this build of compiler.`,
    [46 /* X_MODULE_MODE_NOT_SUPPORTED */]: `ES module mode is not supported in this build of compiler.`,
    [47 /* X_CACHE_HANDLER_NOT_SUPPORTED */]: `"cacheHandlers" option is only supported when the "prefixIdentifiers" option is enabled.`,
    [48 /* X_SCOPE_ID_NOT_SUPPORTED */]: `"scopeId" option is only supported in module mode.`
};

const FRAGMENT = Symbol(`Fragment` );
const TELEPORT = Symbol(`Teleport` );
const SUSPENSE = Symbol(`Suspense` );
const KEEP_ALIVE = Symbol(`KeepAlive` );
const BASE_TRANSITION = Symbol(`BaseTransition` );
const OPEN_BLOCK = Symbol(`openBlock` );
const CREATE_BLOCK = Symbol(`createBlock` );
const CREATE_VNODE = Symbol(`createVNode` );
const CREATE_COMMENT = Symbol(`createCommentVNode` );
const CREATE_TEXT = Symbol(`createTextVNode` );
const CREATE_STATIC = Symbol(`createStaticVNode` );
const RESOLVE_COMPONENT = Symbol(`resolveComponent` );
const RESOLVE_DYNAMIC_COMPONENT = Symbol(`resolveDynamicComponent` );
const RESOLVE_DIRECTIVE = Symbol(`resolveDirective` );
const WITH_DIRECTIVES = Symbol(`withDirectives` );
const RENDER_LIST = Symbol(`renderList` );
const RENDER_SLOT = Symbol(`renderSlot` );
const CREATE_SLOTS = Symbol(`createSlots` );
const TO_DISPLAY_STRING = Symbol(`toDisplayString` );
const MERGE_PROPS = Symbol(`mergeProps` );
const TO_HANDLERS = Symbol(`toHandlers` );
const CAMELIZE = Symbol(`camelize` );
const CAPITALIZE = Symbol(`capitalize` );
const TO_HANDLER_KEY = Symbol(`toHandlerKey` );
const SET_BLOCK_TRACKING = Symbol(`setBlockTracking` );
const PUSH_SCOPE_ID = Symbol(`pushScopeId` );
const POP_SCOPE_ID = Symbol(`popScopeId` );
const WITH_SCOPE_ID = Symbol(`withScopeId` );
const WITH_CTX = Symbol(`withCtx` );
const UNREF = Symbol(`unref` );
const IS_REF = Symbol(`isRef` );
// Name mapping for runtime helpers that need to be imported from 'vue' in
// generated code. Make sure these are correctly exported in the runtime!
// Using `any` here because TS doesn't allow symbols as index type.
const helperNameMap = {
    [FRAGMENT]: `Fragment`,
    [TELEPORT]: `Teleport`,
    [SUSPENSE]: `Suspense`,
    [KEEP_ALIVE]: `KeepAlive`,
    [BASE_TRANSITION]: `BaseTransition`,
    [OPEN_BLOCK]: `openBlock`,
    [CREATE_BLOCK]: `createBlock`,
    [CREATE_VNODE]: `createVNode`,
    [CREATE_COMMENT]: `createCommentVNode`,
    [CREATE_TEXT]: `createTextVNode`,
    [CREATE_STATIC]: `createStaticVNode`,
    [RESOLVE_COMPONENT]: `resolveComponent`,
    [RESOLVE_DYNAMIC_COMPONENT]: `resolveDynamicComponent`,
    [RESOLVE_DIRECTIVE]: `resolveDirective`,
    [WITH_DIRECTIVES]: `withDirectives`,
    [RENDER_LIST]: `renderList`,
    [RENDER_SLOT]: `renderSlot`,
    [CREATE_SLOTS]: `createSlots`,
    [TO_DISPLAY_STRING]: `toDisplayString`,
    [MERGE_PROPS]: `mergeProps`,
    [TO_HANDLERS]: `toHandlers`,
    [CAMELIZE]: `camelize`,
    [CAPITALIZE]: `capitalize`,
    [TO_HANDLER_KEY]: `toHandlerKey`,
    [SET_BLOCK_TRACKING]: `setBlockTracking`,
    [PUSH_SCOPE_ID]: `pushScopeId`,
    [POP_SCOPE_ID]: `popScopeId`,
    [WITH_SCOPE_ID]: `withScopeId`,
    [WITH_CTX]: `withCtx`,
    [UNREF]: `unref`,
    [IS_REF]: `isRef`
};
function registerRuntimeHelpers(helpers) {
    Object.getOwnPropertySymbols(helpers).forEach(s => {
        helperNameMap[s] = helpers[s];
    });
}

// AST Utilities ---------------------------------------------------------------
// Some expressions, e.g. sequence and conditional expressions, are never
// associated with template nodes, so their source locations are just a stub.
// Container types like CompoundExpression also don't need a real location.
const locStub = {
    source: '',
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 }
};
function createRoot(children, loc = locStub) {
    return {
        type: 0 /* ROOT */,
        children,
        helpers: [],
        components: [],
        directives: [],
        hoists: [],
        imports: [],
        cached: 0,
        temps: 0,
        codegenNode: undefined,
        loc
    };
}
function createVNodeCall(context, tag, props, children, patchFlag, dynamicProps, directives, isBlock = false, disableTracking = false, loc = locStub) {
    if (context) {
        if (isBlock) {
            context.helper(OPEN_BLOCK);
            context.helper(CREATE_BLOCK);
        }
        else {
            context.helper(CREATE_VNODE);
        }
        if (directives) {
            context.helper(WITH_DIRECTIVES);
        }
    }
    return {
        type: 13 /* VNODE_CALL */,
        tag,
        props,
        children,
        patchFlag,
        dynamicProps,
        directives,
        isBlock,
        disableTracking,
        loc
    };
}
function createArrayExpression(elements, loc = locStub) {
    return {
        type: 17 /* JS_ARRAY_EXPRESSION */,
        loc,
        elements
    };
}
function createObjectExpression(properties, loc = locStub) {
    return {
        type: 15 /* JS_OBJECT_EXPRESSION */,
        loc,
        properties
    };
}
function createObjectProperty(key, value) {
    return {
        type: 16 /* JS_PROPERTY */,
        loc: locStub,
        key: isString(key) ? createSimpleExpression(key, true) : key,
        value
    };
}
function createSimpleExpression(content, isStatic, loc = locStub, constType = 0 /* NOT_CONSTANT */) {
    return {
        type: 4 /* SIMPLE_EXPRESSION */,
        loc,
        content,
        isStatic,
        constType: isStatic ? 3 /* CAN_STRINGIFY */ : constType
    };
}
function createInterpolation(content, loc) {
    return {
        type: 5 /* INTERPOLATION */,
        loc,
        content: isString(content)
            ? createSimpleExpression(content, false, loc)
            : content
    };
}
function createCompoundExpression(children, loc = locStub) {
    return {
        type: 8 /* COMPOUND_EXPRESSION */,
        loc,
        children
    };
}
function createCallExpression(callee, args = [], loc = locStub) {
    return {
        type: 14 /* JS_CALL_EXPRESSION */,
        loc,
        callee,
        arguments: args
    };
}
function createFunctionExpression(params, returns = undefined, newline = false, isSlot = false, loc = locStub) {
    return {
        type: 18 /* JS_FUNCTION_EXPRESSION */,
        params,
        returns,
        newline,
        isSlot,
        loc
    };
}
function createConditionalExpression(test, consequent, alternate, newline = true) {
    return {
        type: 19 /* JS_CONDITIONAL_EXPRESSION */,
        test,
        consequent,
        alternate,
        newline,
        loc: locStub
    };
}
function createCacheExpression(index, value, isVNode = false) {
    return {
        type: 20 /* JS_CACHE_EXPRESSION */,
        index,
        value,
        isVNode,
        loc: locStub
    };
}
function createBlockStatement(body) {
    return {
        type: 21 /* JS_BLOCK_STATEMENT */,
        body,
        loc: locStub
    };
}
function createTemplateLiteral(elements) {
    return {
        type: 22 /* JS_TEMPLATE_LITERAL */,
        elements,
        loc: locStub
    };
}
function createIfStatement(test, consequent, alternate) {
    return {
        type: 23 /* JS_IF_STATEMENT */,
        test,
        consequent,
        alternate,
        loc: locStub
    };
}
function createAssignmentExpression(left, right) {
    return {
        type: 24 /* JS_ASSIGNMENT_EXPRESSION */,
        left,
        right,
        loc: locStub
    };
}
function createSequenceExpression(expressions) {
    return {
        type: 25 /* JS_SEQUENCE_EXPRESSION */,
        expressions,
        loc: locStub
    };
}
function createReturnStatement(returns) {
    return {
        type: 26 /* JS_RETURN_STATEMENT */,
        returns,
        loc: locStub
    };
}

const isStaticExp = (p) => p.type === 4 /* SIMPLE_EXPRESSION */ && p.isStatic;
const isBuiltInType = (tag, expected) => tag === expected || tag === hyphenate(expected);
function isCoreComponent(tag) {
    if (isBuiltInType(tag, 'Teleport')) {
        return TELEPORT;
    }
    else if (isBuiltInType(tag, 'Suspense')) {
        return SUSPENSE;
    }
    else if (isBuiltInType(tag, 'KeepAlive')) {
        return KEEP_ALIVE;
    }
    else if (isBuiltInType(tag, 'BaseTransition')) {
        return BASE_TRANSITION;
    }
}
const nonIdentifierRE = /^\d|[^\$\w]/;
const isSimpleIdentifier = (name) => !nonIdentifierRE.test(name);
const memberExpRE = /^[A-Za-z_$\xA0-\uFFFF][\w$\xA0-\uFFFF]*(?:\s*\.\s*[A-Za-z_$\xA0-\uFFFF][\w$\xA0-\uFFFF]*|\[[^\]]+\])*$/;
const isMemberExpression = (path) => {
    if (!path)
        return false;
    return memberExpRE.test(path.trim());
};
function getInnerRange(loc, offset, length) {
    const source = loc.source.substr(offset, length);
    const newLoc = {
        source,
        start: advancePositionWithClone(loc.start, loc.source, offset),
        end: loc.end
    };
    if (length != null) {
        newLoc.end = advancePositionWithClone(loc.start, loc.source, offset + length);
    }
    return newLoc;
}
function advancePositionWithClone(pos, source, numberOfCharacters = source.length) {
    return advancePositionWithMutation(extend({}, pos), source, numberOfCharacters);
}
// advance by mutation without cloning (for performance reasons), since this
// gets called a lot in the parser
function advancePositionWithMutation(pos, source, numberOfCharacters = source.length) {
    let linesCount = 0;
    let lastNewLinePos = -1;
    for (let i = 0; i < numberOfCharacters; i++) {
        if (source.charCodeAt(i) === 10 /* newline char code */) {
            linesCount++;
            lastNewLinePos = i;
        }
    }
    pos.offset += numberOfCharacters;
    pos.line += linesCount;
    pos.column =
        lastNewLinePos === -1
            ? pos.column + numberOfCharacters
            : numberOfCharacters - lastNewLinePos;
    return pos;
}
function assert(condition, msg) {
    /* istanbul ignore if */
    if (!condition) {
        throw new Error(msg || `unexpected compiler condition`);
    }
}
function findDir(node, name, allowEmpty = false) {
    for (let i = 0; i < node.props.length; i++) {
        const p = node.props[i];
        if (p.type === 7 /* DIRECTIVE */ &&
            (allowEmpty || p.exp) &&
            (isString(name) ? p.name === name : name.test(p.name))) {
            return p;
        }
    }
}
function findProp(node, name, dynamicOnly = false, allowEmpty = false) {
    for (let i = 0; i < node.props.length; i++) {
        const p = node.props[i];
        if (p.type === 6 /* ATTRIBUTE */) {
            if (dynamicOnly)
                continue;
            if (p.name === name && (p.value || allowEmpty)) {
                return p;
            }
        }
        else if (p.name === 'bind' &&
            (p.exp || allowEmpty) &&
            isBindKey(p.arg, name)) {
            return p;
        }
    }
}
function isBindKey(arg, name) {
    return !!(arg && isStaticExp(arg) && arg.content === name);
}
function hasDynamicKeyVBind(node) {
    return node.props.some(p => p.type === 7 /* DIRECTIVE */ &&
        p.name === 'bind' &&
        (!p.arg || // v-bind="obj"
            p.arg.type !== 4 /* SIMPLE_EXPRESSION */ || // v-bind:[_ctx.foo]
            !p.arg.isStatic) // v-bind:[foo]
    );
}
function isText(node) {
    return node.type === 5 /* INTERPOLATION */ || node.type === 2 /* TEXT */;
}
function isVSlot(p) {
    return p.type === 7 /* DIRECTIVE */ && p.name === 'slot';
}
function isTemplateNode(node) {
    return (node.type === 1 /* ELEMENT */ && node.tagType === 3 /* TEMPLATE */);
}
function isSlotOutlet(node) {
    return node.type === 1 /* ELEMENT */ && node.tagType === 2 /* SLOT */;
}
function injectProp(node, prop, context) {
    let propsWithInjection;
    const props = node.type === 13 /* VNODE_CALL */ ? node.props : node.arguments[2];
    if (props == null || isString(props)) {
        propsWithInjection = createObjectExpression([prop]);
    }
    else if (props.type === 14 /* JS_CALL_EXPRESSION */) {
        // merged props... add ours
        // only inject key to object literal if it's the first argument so that
        // if doesn't override user provided keys
        const first = props.arguments[0];
        if (!isString(first) && first.type === 15 /* JS_OBJECT_EXPRESSION */) {
            first.properties.unshift(prop);
        }
        else {
            if (props.callee === TO_HANDLERS) {
                // #2366
                propsWithInjection = createCallExpression(context.helper(MERGE_PROPS), [
                    createObjectExpression([prop]),
                    props
                ]);
            }
            else {
                props.arguments.unshift(createObjectExpression([prop]));
            }
        }
        !propsWithInjection && (propsWithInjection = props);
    }
    else if (props.type === 15 /* JS_OBJECT_EXPRESSION */) {
        let alreadyExists = false;
        // check existing key to avoid overriding user provided keys
        if (prop.key.type === 4 /* SIMPLE_EXPRESSION */) {
            const propKeyName = prop.key.content;
            alreadyExists = props.properties.some(p => p.key.type === 4 /* SIMPLE_EXPRESSION */ &&
                p.key.content === propKeyName);
        }
        if (!alreadyExists) {
            props.properties.unshift(prop);
        }
        propsWithInjection = props;
    }
    else {
        // single v-bind with expression, return a merged replacement
        propsWithInjection = createCallExpression(context.helper(MERGE_PROPS), [
            createObjectExpression([prop]),
            props
        ]);
    }
    if (node.type === 13 /* VNODE_CALL */) {
        node.props = propsWithInjection;
    }
    else {
        node.arguments[2] = propsWithInjection;
    }
}
function toValidAssetId(name, type) {
    return `_${type}_${name.replace(/[^\w]/g, '_')}`;
}
// Check if a node contains expressions that reference current context scope ids
function hasScopeRef(node, ids) {
    if (!node || Object.keys(ids).length === 0) {
        return false;
    }
    switch (node.type) {
        case 1 /* ELEMENT */:
            for (let i = 0; i < node.props.length; i++) {
                const p = node.props[i];
                if (p.type === 7 /* DIRECTIVE */ &&
                    (hasScopeRef(p.arg, ids) || hasScopeRef(p.exp, ids))) {
                    return true;
                }
            }
            return node.children.some(c => hasScopeRef(c, ids));
        case 11 /* FOR */:
            if (hasScopeRef(node.source, ids)) {
                return true;
            }
            return node.children.some(c => hasScopeRef(c, ids));
        case 9 /* IF */:
            return node.branches.some(b => hasScopeRef(b, ids));
        case 10 /* IF_BRANCH */:
            if (hasScopeRef(node.condition, ids)) {
                return true;
            }
            return node.children.some(c => hasScopeRef(c, ids));
        case 4 /* SIMPLE_EXPRESSION */:
            return (!node.isStatic &&
                isSimpleIdentifier(node.content) &&
                !!ids[node.content]);
        case 8 /* COMPOUND_EXPRESSION */:
            return node.children.some(c => isObject(c) && hasScopeRef(c, ids));
        case 5 /* INTERPOLATION */:
        case 12 /* TEXT_CALL */:
            return hasScopeRef(node.content, ids);
        case 2 /* TEXT */:
        case 3 /* COMMENT */:
            return false;
        default:
            return false;
    }
}

// The default decoder only provides escapes for characters reserved as part of
// the template syntax, and is only used if the custom renderer did not provide
// a platform-specific decoder.
const decodeRE = /&(gt|lt|amp|apos|quot);/g;
const decodeMap = {
    gt: '>',
    lt: '<',
    amp: '&',
    apos: "'",
    quot: '"'
};
const defaultParserOptions = {
    delimiters: [`{{`, `}}`],
    getNamespace: () => 0 /* HTML */,
    getTextMode: () => 0 /* DATA */,
    isVoidTag: NO,
    isPreTag: NO,
    isCustomElement: NO,
    decodeEntities: (rawText) => rawText.replace(decodeRE, (_, p1) => decodeMap[p1]),
    onError: defaultOnError,
    comments: false
};
function baseParse(content, options = {}) {
    const context = createParserContext(content, options);
    const start = getCursor(context);
    return createRoot(parseChildren(context, 0 /* DATA */, []), getSelection(context, start));
}
function createParserContext(content, rawOptions) {
    const options = extend({}, defaultParserOptions);
    for (const key in rawOptions) {
        // @ts-ignore
        options[key] = rawOptions[key] || defaultParserOptions[key];
    }
    return {
        options,
        column: 1,
        line: 1,
        offset: 0,
        originalSource: content,
        source: content,
        inPre: false,
        inVPre: false
    };
}
function parseChildren(context, mode, ancestors) {
    const parent = last(ancestors);
    const ns = parent ? parent.ns : 0 /* HTML */;
    const nodes = [];
    while (!isEnd(context, mode, ancestors)) {
        const s = context.source;
        let node = undefined;
        if (mode === 0 /* DATA */ || mode === 1 /* RCDATA */) {
            if (!context.inVPre && startsWith(s, context.options.delimiters[0])) {
                // '{{'
                node = parseInterpolation(context, mode);
            }
            else if (mode === 0 /* DATA */ && s[0] === '<') {
                // https://html.spec.whatwg.org/multipage/parsing.html#tag-open-state
                if (s.length === 1) {
                    emitError(context, 5 /* EOF_BEFORE_TAG_NAME */, 1);
                }
                else if (s[1] === '!') {
                    // https://html.spec.whatwg.org/multipage/parsing.html#markup-declaration-open-state
                    if (startsWith(s, '<!--')) {
                        node = parseComment(context);
                    }
                    else if (startsWith(s, '<!DOCTYPE')) {
                        // Ignore DOCTYPE by a limitation.
                        node = parseBogusComment(context);
                    }
                    else if (startsWith(s, '<![CDATA[')) {
                        if (ns !== 0 /* HTML */) {
                            node = parseCDATA(context, ancestors);
                        }
                        else {
                            emitError(context, 1 /* CDATA_IN_HTML_CONTENT */);
                            node = parseBogusComment(context);
                        }
                    }
                    else {
                        emitError(context, 11 /* INCORRECTLY_OPENED_COMMENT */);
                        node = parseBogusComment(context);
                    }
                }
                else if (s[1] === '/') {
                    // https://html.spec.whatwg.org/multipage/parsing.html#end-tag-open-state
                    if (s.length === 2) {
                        emitError(context, 5 /* EOF_BEFORE_TAG_NAME */, 2);
                    }
                    else if (s[2] === '>') {
                        emitError(context, 14 /* MISSING_END_TAG_NAME */, 2);
                        advanceBy(context, 3);
                        continue;
                    }
                    else if (/[a-z]/i.test(s[2])) {
                        emitError(context, 23 /* X_INVALID_END_TAG */);
                        parseTag(context, 1 /* End */, parent);
                        continue;
                    }
                    else {
                        emitError(context, 12 /* INVALID_FIRST_CHARACTER_OF_TAG_NAME */, 2);
                        node = parseBogusComment(context);
                    }
                }
                else if (/[a-z]/i.test(s[1])) {
                    node = parseElement(context, ancestors);
                }
                else if (s[1] === '?') {
                    emitError(context, 21 /* UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME */, 1);
                    node = parseBogusComment(context);
                }
                else {
                    emitError(context, 12 /* INVALID_FIRST_CHARACTER_OF_TAG_NAME */, 1);
                }
            }
        }
        if (!node) {
            node = parseText(context, mode);
        }
        if (isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                pushNode(nodes, node[i]);
            }
        }
        else {
            pushNode(nodes, node);
        }
    }
    // Whitespace management for more efficient output
    // (same as v2 whitespace: 'condense')
    let removedWhitespace = false;
    if (mode !== 2 /* RAWTEXT */ && mode !== 1 /* RCDATA */) {
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (!context.inPre && node.type === 2 /* TEXT */) {
                if (!/[^\t\r\n\f ]/.test(node.content)) {
                    const prev = nodes[i - 1];
                    const next = nodes[i + 1];
                    // If:
                    // - the whitespace is the first or last node, or:
                    // - the whitespace is adjacent to a comment, or:
                    // - the whitespace is between two elements AND contains newline
                    // Then the whitespace is ignored.
                    if (!prev ||
                        !next ||
                        prev.type === 3 /* COMMENT */ ||
                        next.type === 3 /* COMMENT */ ||
                        (prev.type === 1 /* ELEMENT */ &&
                            next.type === 1 /* ELEMENT */ &&
                            /[\r\n]/.test(node.content))) {
                        removedWhitespace = true;
                        nodes[i] = null;
                    }
                    else {
                        // Otherwise, condensed consecutive whitespace inside the text
                        // down to a single space
                        node.content = ' ';
                    }
                }
                else {
                    node.content = node.content.replace(/[\t\r\n\f ]+/g, ' ');
                }
            }
        }
        if (context.inPre && parent && context.options.isPreTag(parent.tag)) {
            // remove leading newline per html spec
            // https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
            const first = nodes[0];
            if (first && first.type === 2 /* TEXT */) {
                first.content = first.content.replace(/^\r?\n/, '');
            }
        }
    }
    return removedWhitespace ? nodes.filter(Boolean) : nodes;
}
function pushNode(nodes, node) {
    if (node.type === 2 /* TEXT */) {
        const prev = last(nodes);
        // Merge if both this and the previous node are text and those are
        // consecutive. This happens for cases like "a < b".
        if (prev &&
            prev.type === 2 /* TEXT */ &&
            prev.loc.end.offset === node.loc.start.offset) {
            prev.content += node.content;
            prev.loc.end = node.loc.end;
            prev.loc.source += node.loc.source;
            return;
        }
    }
    nodes.push(node);
}
function parseCDATA(context, ancestors) {
    advanceBy(context, 9);
    const nodes = parseChildren(context, 3 /* CDATA */, ancestors);
    if (context.source.length === 0) {
        emitError(context, 6 /* EOF_IN_CDATA */);
    }
    else {
        advanceBy(context, 3);
    }
    return nodes;
}
function parseComment(context) {
    const start = getCursor(context);
    let content;
    // Regular comment.
    const match = /--(\!)?>/.exec(context.source);
    if (!match) {
        content = context.source.slice(4);
        advanceBy(context, context.source.length);
        emitError(context, 7 /* EOF_IN_COMMENT */);
    }
    else {
        if (match.index <= 3) {
            emitError(context, 0 /* ABRUPT_CLOSING_OF_EMPTY_COMMENT */);
        }
        if (match[1]) {
            emitError(context, 10 /* INCORRECTLY_CLOSED_COMMENT */);
        }
        content = context.source.slice(4, match.index);
        // Advancing with reporting nested comments.
        const s = context.source.slice(0, match.index);
        let prevIndex = 1, nestedIndex = 0;
        while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
            advanceBy(context, nestedIndex - prevIndex + 1);
            if (nestedIndex + 4 < s.length) {
                emitError(context, 16 /* NESTED_COMMENT */);
            }
            prevIndex = nestedIndex + 1;
        }
        advanceBy(context, match.index + match[0].length - prevIndex + 1);
    }
    return {
        type: 3 /* COMMENT */,
        content,
        loc: getSelection(context, start)
    };
}
function parseBogusComment(context) {
    const start = getCursor(context);
    const contentStart = context.source[1] === '?' ? 1 : 2;
    let content;
    const closeIndex = context.source.indexOf('>');
    if (closeIndex === -1) {
        content = context.source.slice(contentStart);
        advanceBy(context, context.source.length);
    }
    else {
        content = context.source.slice(contentStart, closeIndex);
        advanceBy(context, closeIndex + 1);
    }
    return {
        type: 3 /* COMMENT */,
        content,
        loc: getSelection(context, start)
    };
}
function parseElement(context, ancestors) {
    // Start tag.
    const wasInPre = context.inPre;
    const wasInVPre = context.inVPre;
    const parent = last(ancestors);
    const element = parseTag(context, 0 /* Start */, parent);
    const isPreBoundary = context.inPre && !wasInPre;
    const isVPreBoundary = context.inVPre && !wasInVPre;
    if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
        return element;
    }
    // Children.
    ancestors.push(element);
    const mode = context.options.getTextMode(element, parent);
    const children = parseChildren(context, mode, ancestors);
    ancestors.pop();
    element.children = children;
    // End tag.
    if (startsWithEndTagOpen(context.source, element.tag)) {
        parseTag(context, 1 /* End */, parent);
    }
    else {
        emitError(context, 24 /* X_MISSING_END_TAG */, 0, element.loc.start);
        if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
            const first = children[0];
            if (first && startsWith(first.loc.source, '<!--')) {
                emitError(context, 8 /* EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT */);
            }
        }
    }
    element.loc = getSelection(context, element.loc.start);
    if (isPreBoundary) {
        context.inPre = false;
    }
    if (isVPreBoundary) {
        context.inVPre = false;
    }
    return element;
}
const isSpecialTemplateDirective = /*#__PURE__*/ makeMap(`if,else,else-if,for,slot`);
/**
 * Parse a tag (E.g. `<div id=a>`) with that type (start tag or end tag).
 */
function parseTag(context, type, parent) {
    // Tag open.
    const start = getCursor(context);
    const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source);
    const tag = match[1];
    const ns = context.options.getNamespace(tag, parent);
    advanceBy(context, match[0].length);
    advanceSpaces(context);
    // save current state in case we need to re-parse attributes with v-pre
    const cursor = getCursor(context);
    const currentSource = context.source;
    // Attributes.
    let props = parseAttributes(context, type);
    // check <pre> tag
    if (context.options.isPreTag(tag)) {
        context.inPre = true;
    }
    // check v-pre
    if (!context.inVPre &&
        props.some(p => p.type === 7 /* DIRECTIVE */ && p.name === 'pre')) {
        context.inVPre = true;
        // reset context
        extend(context, cursor);
        context.source = currentSource;
        // re-parse attrs and filter out v-pre itself
        props = parseAttributes(context, type).filter(p => p.name !== 'v-pre');
    }
    // Tag close.
    let isSelfClosing = false;
    if (context.source.length === 0) {
        emitError(context, 9 /* EOF_IN_TAG */);
    }
    else {
        isSelfClosing = startsWith(context.source, '/>');
        if (type === 1 /* End */ && isSelfClosing) {
            emitError(context, 4 /* END_TAG_WITH_TRAILING_SOLIDUS */);
        }
        advanceBy(context, isSelfClosing ? 2 : 1);
    }
    let tagType = 0 /* ELEMENT */;
    const options = context.options;
    if (!context.inVPre && !options.isCustomElement(tag)) {
        const hasVIs = props.some(p => p.type === 7 /* DIRECTIVE */ && p.name === 'is');
        if (options.isNativeTag && !hasVIs) {
            if (!options.isNativeTag(tag))
                tagType = 1 /* COMPONENT */;
        }
        else if (hasVIs ||
            isCoreComponent(tag) ||
            (options.isBuiltInComponent && options.isBuiltInComponent(tag)) ||
            /^[A-Z]/.test(tag) ||
            tag === 'component') {
            tagType = 1 /* COMPONENT */;
        }
        if (tag === 'slot') {
            tagType = 2 /* SLOT */;
        }
        else if (tag === 'template' &&
            props.some(p => {
                return (p.type === 7 /* DIRECTIVE */ && isSpecialTemplateDirective(p.name));
            })) {
            tagType = 3 /* TEMPLATE */;
        }
    }
    return {
        type: 1 /* ELEMENT */,
        ns,
        tag,
        tagType,
        props,
        isSelfClosing,
        children: [],
        loc: getSelection(context, start),
        codegenNode: undefined // to be created during transform phase
    };
}
function parseAttributes(context, type) {
    const props = [];
    const attributeNames = new Set();
    while (context.source.length > 0 &&
        !startsWith(context.source, '>') &&
        !startsWith(context.source, '/>')) {
        if (startsWith(context.source, '/')) {
            emitError(context, 22 /* UNEXPECTED_SOLIDUS_IN_TAG */);
            advanceBy(context, 1);
            advanceSpaces(context);
            continue;
        }
        if (type === 1 /* End */) {
            emitError(context, 3 /* END_TAG_WITH_ATTRIBUTES */);
        }
        const attr = parseAttribute(context, attributeNames);
        if (type === 0 /* Start */) {
            props.push(attr);
        }
        if (/^[^\t\r\n\f />]/.test(context.source)) {
            emitError(context, 15 /* MISSING_WHITESPACE_BETWEEN_ATTRIBUTES */);
        }
        advanceSpaces(context);
    }
    return props;
}
function parseAttribute(context, nameSet) {
    // Name.
    const start = getCursor(context);
    const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source);
    const name = match[0];
    if (nameSet.has(name)) {
        emitError(context, 2 /* DUPLICATE_ATTRIBUTE */);
    }
    nameSet.add(name);
    if (name[0] === '=') {
        emitError(context, 19 /* UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME */);
    }
    {
        const pattern = /["'<]/g;
        let m;
        while ((m = pattern.exec(name))) {
            emitError(context, 17 /* UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME */, m.index);
        }
    }
    advanceBy(context, name.length);
    // Value
    let value = undefined;
    if (/^[\t\r\n\f ]*=/.test(context.source)) {
        advanceSpaces(context);
        advanceBy(context, 1);
        advanceSpaces(context);
        value = parseAttributeValue(context);
        if (!value) {
            emitError(context, 13 /* MISSING_ATTRIBUTE_VALUE */);
        }
    }
    const loc = getSelection(context, start);
    if (!context.inVPre && /^(v-|:|@|#)/.test(name)) {
        const match = /(?:^v-([a-z0-9-]+))?(?:(?::|^@|^#)(\[[^\]]+\]|[^\.]+))?(.+)?$/i.exec(name);
        const dirName = match[1] ||
            (startsWith(name, ':') ? 'bind' : startsWith(name, '@') ? 'on' : 'slot');
        let arg;
        if (match[2]) {
            const isSlot = dirName === 'slot';
            const startOffset = name.lastIndexOf(match[2]);
            const loc = getSelection(context, getNewPosition(context, start, startOffset), getNewPosition(context, start, startOffset + match[2].length + ((isSlot && match[3]) || '').length));
            let content = match[2];
            let isStatic = true;
            if (content.startsWith('[')) {
                isStatic = false;
                if (!content.endsWith(']')) {
                    emitError(context, 26 /* X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END */);
                }
                content = content.substr(1, content.length - 2);
            }
            else if (isSlot) {
                // #1241 special case for v-slot: vuetify relies extensively on slot
                // names containing dots. v-slot doesn't have any modifiers and Vue 2.x
                // supports such usage so we are keeping it consistent with 2.x.
                content += match[3] || '';
            }
            arg = {
                type: 4 /* SIMPLE_EXPRESSION */,
                content,
                isStatic,
                constType: isStatic
                    ? 3 /* CAN_STRINGIFY */
                    : 0 /* NOT_CONSTANT */,
                loc
            };
        }
        if (value && value.isQuoted) {
            const valueLoc = value.loc;
            valueLoc.start.offset++;
            valueLoc.start.column++;
            valueLoc.end = advancePositionWithClone(valueLoc.start, value.content);
            valueLoc.source = valueLoc.source.slice(1, -1);
        }
        return {
            type: 7 /* DIRECTIVE */,
            name: dirName,
            exp: value && {
                type: 4 /* SIMPLE_EXPRESSION */,
                content: value.content,
                isStatic: false,
                // Treat as non-constant by default. This can be potentially set to
                // other values by `transformExpression` to make it eligible for hoisting.
                constType: 0 /* NOT_CONSTANT */,
                loc: value.loc
            },
            arg,
            modifiers: match[3] ? match[3].substr(1).split('.') : [],
            loc
        };
    }
    return {
        type: 6 /* ATTRIBUTE */,
        name,
        value: value && {
            type: 2 /* TEXT */,
            content: value.content,
            loc: value.loc
        },
        loc
    };
}
function parseAttributeValue(context) {
    const start = getCursor(context);
    let content;
    const quote = context.source[0];
    const isQuoted = quote === `"` || quote === `'`;
    if (isQuoted) {
        // Quoted value.
        advanceBy(context, 1);
        const endIndex = context.source.indexOf(quote);
        if (endIndex === -1) {
            content = parseTextData(context, context.source.length, 4 /* ATTRIBUTE_VALUE */);
        }
        else {
            content = parseTextData(context, endIndex, 4 /* ATTRIBUTE_VALUE */);
            advanceBy(context, 1);
        }
    }
    else {
        // Unquoted
        const match = /^[^\t\r\n\f >]+/.exec(context.source);
        if (!match) {
            return undefined;
        }
        const unexpectedChars = /["'<=`]/g;
        let m;
        while ((m = unexpectedChars.exec(match[0]))) {
            emitError(context, 18 /* UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE */, m.index);
        }
        content = parseTextData(context, match[0].length, 4 /* ATTRIBUTE_VALUE */);
    }
    return { content, isQuoted, loc: getSelection(context, start) };
}
function parseInterpolation(context, mode) {
    const [open, close] = context.options.delimiters;
    const closeIndex = context.source.indexOf(close, open.length);
    if (closeIndex === -1) {
        emitError(context, 25 /* X_MISSING_INTERPOLATION_END */);
        return undefined;
    }
    const start = getCursor(context);
    advanceBy(context, open.length);
    const innerStart = getCursor(context);
    const innerEnd = getCursor(context);
    const rawContentLength = closeIndex - open.length;
    const rawContent = context.source.slice(0, rawContentLength);
    const preTrimContent = parseTextData(context, rawContentLength, mode);
    const content = preTrimContent.trim();
    const startOffset = preTrimContent.indexOf(content);
    if (startOffset > 0) {
        advancePositionWithMutation(innerStart, rawContent, startOffset);
    }
    const endOffset = rawContentLength - (preTrimContent.length - content.length - startOffset);
    advancePositionWithMutation(innerEnd, rawContent, endOffset);
    advanceBy(context, close.length);
    return {
        type: 5 /* INTERPOLATION */,
        content: {
            type: 4 /* SIMPLE_EXPRESSION */,
            isStatic: false,
            // Set `isConstant` to false by default and will decide in transformExpression
            constType: 0 /* NOT_CONSTANT */,
            content,
            loc: getSelection(context, innerStart, innerEnd)
        },
        loc: getSelection(context, start)
    };
}
function parseText(context, mode) {
    const endTokens = ['<', context.options.delimiters[0]];
    if (mode === 3 /* CDATA */) {
        endTokens.push(']]>');
    }
    let endIndex = context.source.length;
    for (let i = 0; i < endTokens.length; i++) {
        const index = context.source.indexOf(endTokens[i], 1);
        if (index !== -1 && endIndex > index) {
            endIndex = index;
        }
    }
    const start = getCursor(context);
    const content = parseTextData(context, endIndex, mode);
    return {
        type: 2 /* TEXT */,
        content,
        loc: getSelection(context, start)
    };
}
/**
 * Get text data with a given length from the current location.
 * This translates HTML entities in the text data.
 */
function parseTextData(context, length, mode) {
    const rawText = context.source.slice(0, length);
    advanceBy(context, length);
    if (mode === 2 /* RAWTEXT */ ||
        mode === 3 /* CDATA */ ||
        rawText.indexOf('&') === -1) {
        return rawText;
    }
    else {
        // DATA or RCDATA containing "&"". Entity decoding required.
        return context.options.decodeEntities(rawText, mode === 4 /* ATTRIBUTE_VALUE */);
    }
}
function getCursor(context) {
    const { column, line, offset } = context;
    return { column, line, offset };
}
function getSelection(context, start, end) {
    end = end || getCursor(context);
    return {
        start,
        end,
        source: context.originalSource.slice(start.offset, end.offset)
    };
}
function last(xs) {
    return xs[xs.length - 1];
}
function startsWith(source, searchString) {
    return source.startsWith(searchString);
}
function advanceBy(context, numberOfCharacters) {
    const { source } = context;
    advancePositionWithMutation(context, source, numberOfCharacters);
    context.source = source.slice(numberOfCharacters);
}
function advanceSpaces(context) {
    const match = /^[\t\r\n\f ]+/.exec(context.source);
    if (match) {
        advanceBy(context, match[0].length);
    }
}
function getNewPosition(context, start, numberOfCharacters) {
    return advancePositionWithClone(start, context.originalSource.slice(start.offset, numberOfCharacters), numberOfCharacters);
}
function emitError(context, code, offset, loc = getCursor(context)) {
    if (offset) {
        loc.offset += offset;
        loc.column += offset;
    }
    context.options.onError(createCompilerError(code, {
        start: loc,
        end: loc,
        source: ''
    }));
}
function isEnd(context, mode, ancestors) {
    const s = context.source;
    switch (mode) {
        case 0 /* DATA */:
            if (startsWith(s, '</')) {
                // TODO: probably bad performance
                for (let i = ancestors.length - 1; i >= 0; --i) {
                    if (startsWithEndTagOpen(s, ancestors[i].tag)) {
                        return true;
                    }
                }
            }
            break;
        case 1 /* RCDATA */:
        case 2 /* RAWTEXT */: {
            const parent = last(ancestors);
            if (parent && startsWithEndTagOpen(s, parent.tag)) {
                return true;
            }
            break;
        }
        case 3 /* CDATA */:
            if (startsWith(s, ']]>')) {
                return true;
            }
            break;
    }
    return !s;
}
function startsWithEndTagOpen(source, tag) {
    return (startsWith(source, '</') &&
        source.substr(2, tag.length).toLowerCase() === tag.toLowerCase() &&
        /[\t\r\n\f />]/.test(source[2 + tag.length] || '>'));
}

function hoistStatic(root, context) {
    walk(root, context, 
    // Root node is unfortunately non-hoistable due to potential parent
    // fallthrough attributes.
    isSingleElementRoot(root, root.children[0]));
}
function isSingleElementRoot(root, child) {
    const { children } = root;
    return (children.length === 1 &&
        child.type === 1 /* ELEMENT */ &&
        !isSlotOutlet(child));
}
function walk(node, context, doNotHoistNode = false) {
    let hasHoistedNode = false;
    // Some transforms, e.g. transformAssetUrls from @vue/compiler-sfc, replaces
    // static bindings with expressions. These expressions are guaranteed to be
    // constant so they are still eligible for hoisting, but they are only
    // available at runtime and therefore cannot be evaluated ahead of time.
    // This is only a concern for pre-stringification (via transformHoist by
    // @vue/compiler-dom), but doing it here allows us to perform only one full
    // walk of the AST and allow `stringifyStatic` to stop walking as soon as its
    // stringficiation threshold is met.
    let canStringify = true;
    const { children } = node;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        // only plain elements & text calls are eligible for hoisting.
        if (child.type === 1 /* ELEMENT */ &&
            child.tagType === 0 /* ELEMENT */) {
            const constantType = doNotHoistNode
                ? 0 /* NOT_CONSTANT */
                : getConstantType(child, context);
            if (constantType > 0 /* NOT_CONSTANT */) {
                if (constantType < 3 /* CAN_STRINGIFY */) {
                    canStringify = false;
                }
                if (constantType >= 2 /* CAN_HOIST */) {
                    child.codegenNode.patchFlag =
                        -1 /* HOISTED */ + (` /* HOISTED */` );
                    child.codegenNode = context.hoist(child.codegenNode);
                    hasHoistedNode = true;
                    continue;
                }
            }
            else {
                // node may contain dynamic children, but its props may be eligible for
                // hoisting.
                const codegenNode = child.codegenNode;
                if (codegenNode.type === 13 /* VNODE_CALL */) {
                    const flag = getPatchFlag(codegenNode);
                    if ((!flag ||
                        flag === 512 /* NEED_PATCH */ ||
                        flag === 1 /* TEXT */) &&
                        getGeneratedPropsConstantType(child, context) >=
                            2 /* CAN_HOIST */) {
                        const props = getNodeProps(child);
                        if (props) {
                            codegenNode.props = context.hoist(props);
                        }
                    }
                }
            }
        }
        else if (child.type === 12 /* TEXT_CALL */) {
            const contentType = getConstantType(child.content, context);
            if (contentType > 0) {
                if (contentType < 3 /* CAN_STRINGIFY */) {
                    canStringify = false;
                }
                if (contentType >= 2 /* CAN_HOIST */) {
                    child.codegenNode = context.hoist(child.codegenNode);
                    hasHoistedNode = true;
                }
            }
        }
        // walk further
        if (child.type === 1 /* ELEMENT */) {
            const isComponent = child.tagType === 1 /* COMPONENT */;
            if (isComponent) {
                context.scopes.vSlot++;
            }
            walk(child, context);
            if (isComponent) {
                context.scopes.vSlot--;
            }
        }
        else if (child.type === 11 /* FOR */) {
            // Do not hoist v-for single child because it has to be a block
            walk(child, context, child.children.length === 1);
        }
        else if (child.type === 9 /* IF */) {
            for (let i = 0; i < child.branches.length; i++) {
                // Do not hoist v-if single child because it has to be a block
                walk(child.branches[i], context, child.branches[i].children.length === 1);
            }
        }
    }
    if (canStringify && hasHoistedNode && context.transformHoist) {
        context.transformHoist(children, context, node);
    }
}
function getConstantType(node, context) {
    const { constantCache } = context;
    switch (node.type) {
        case 1 /* ELEMENT */:
            if (node.tagType !== 0 /* ELEMENT */) {
                return 0 /* NOT_CONSTANT */;
            }
            const cached = constantCache.get(node);
            if (cached !== undefined) {
                return cached;
            }
            const codegenNode = node.codegenNode;
            if (codegenNode.type !== 13 /* VNODE_CALL */) {
                return 0 /* NOT_CONSTANT */;
            }
            const flag = getPatchFlag(codegenNode);
            if (!flag) {
                let returnType = 3 /* CAN_STRINGIFY */;
                // Element itself has no patch flag. However we still need to check:
                // 1. Even for a node with no patch flag, it is possible for it to contain
                // non-hoistable expressions that refers to scope variables, e.g. compiler
                // injected keys or cached event handlers. Therefore we need to always
                // check the codegenNode's props to be sure.
                const generatedPropsType = getGeneratedPropsConstantType(node, context);
                if (generatedPropsType === 0 /* NOT_CONSTANT */) {
                    constantCache.set(node, 0 /* NOT_CONSTANT */);
                    return 0 /* NOT_CONSTANT */;
                }
                if (generatedPropsType < returnType) {
                    returnType = generatedPropsType;
                }
                // 2. its children.
                for (let i = 0; i < node.children.length; i++) {
                    const childType = getConstantType(node.children[i], context);
                    if (childType === 0 /* NOT_CONSTANT */) {
                        constantCache.set(node, 0 /* NOT_CONSTANT */);
                        return 0 /* NOT_CONSTANT */;
                    }
                    if (childType < returnType) {
                        returnType = childType;
                    }
                }
                // 3. if the type is not already CAN_SKIP_PATCH which is the lowest non-0
                // type, check if any of the props can cause the type to be lowered
                // we can skip can_patch because it's guaranteed by the absence of a
                // patchFlag.
                if (returnType > 1 /* CAN_SKIP_PATCH */) {
                    for (let i = 0; i < node.props.length; i++) {
                        const p = node.props[i];
                        if (p.type === 7 /* DIRECTIVE */ && p.name === 'bind' && p.exp) {
                            const expType = getConstantType(p.exp, context);
                            if (expType === 0 /* NOT_CONSTANT */) {
                                constantCache.set(node, 0 /* NOT_CONSTANT */);
                                return 0 /* NOT_CONSTANT */;
                            }
                            if (expType < returnType) {
                                returnType = expType;
                            }
                        }
                    }
                }
                // only svg/foreignObject could be block here, however if they are
                // static then they don't need to be blocks since there will be no
                // nested updates.
                if (codegenNode.isBlock) {
                    context.removeHelper(OPEN_BLOCK);
                    context.removeHelper(CREATE_BLOCK);
                    codegenNode.isBlock = false;
                    context.helper(CREATE_VNODE);
                }
                constantCache.set(node, returnType);
                return returnType;
            }
            else {
                constantCache.set(node, 0 /* NOT_CONSTANT */);
                return 0 /* NOT_CONSTANT */;
            }
        case 2 /* TEXT */:
        case 3 /* COMMENT */:
            return 3 /* CAN_STRINGIFY */;
        case 9 /* IF */:
        case 11 /* FOR */:
        case 10 /* IF_BRANCH */:
            return 0 /* NOT_CONSTANT */;
        case 5 /* INTERPOLATION */:
        case 12 /* TEXT_CALL */:
            return getConstantType(node.content, context);
        case 4 /* SIMPLE_EXPRESSION */:
            return node.constType;
        case 8 /* COMPOUND_EXPRESSION */:
            let returnType = 3 /* CAN_STRINGIFY */;
            for (let i = 0; i < node.children.length; i++) {
                const child = node.children[i];
                if (isString(child) || isSymbol(child)) {
                    continue;
                }
                const childType = getConstantType(child, context);
                if (childType === 0 /* NOT_CONSTANT */) {
                    return 0 /* NOT_CONSTANT */;
                }
                else if (childType < returnType) {
                    returnType = childType;
                }
            }
            return returnType;
        default:
            return 0 /* NOT_CONSTANT */;
    }
}
function getGeneratedPropsConstantType(node, context) {
    let returnType = 3 /* CAN_STRINGIFY */;
    const props = getNodeProps(node);
    if (props && props.type === 15 /* JS_OBJECT_EXPRESSION */) {
        const { properties } = props;
        for (let i = 0; i < properties.length; i++) {
            const { key, value } = properties[i];
            const keyType = getConstantType(key, context);
            if (keyType === 0 /* NOT_CONSTANT */) {
                return keyType;
            }
            if (keyType < returnType) {
                returnType = keyType;
            }
            if (value.type !== 4 /* SIMPLE_EXPRESSION */) {
                return 0 /* NOT_CONSTANT */;
            }
            const valueType = getConstantType(value, context);
            if (valueType === 0 /* NOT_CONSTANT */) {
                return valueType;
            }
            if (valueType < returnType) {
                returnType = valueType;
            }
        }
    }
    return returnType;
}
function getNodeProps(node) {
    const codegenNode = node.codegenNode;
    if (codegenNode.type === 13 /* VNODE_CALL */) {
        return codegenNode.props;
    }
}
function getPatchFlag(node) {
    const flag = node.patchFlag;
    return flag ? parseInt(flag, 10) : undefined;
}

function createTransformContext(root, { filename = '', prefixIdentifiers = false, hoistStatic = false, cacheHandlers = false, nodeTransforms = [], directiveTransforms = {}, transformHoist = null, isBuiltInComponent = NOOP, isCustomElement = NOOP, expressionPlugins = [], scopeId = null, slotted = true, ssr = false, ssrCssVars = ``, bindingMetadata = EMPTY_OBJ, inline = false, isTS = false, onError = defaultOnError }) {
    const nameMatch = filename.replace(/\?.*$/, '').match(/([^/\\]+)\.\w+$/);
    const context = {
        // options
        selfName: nameMatch && capitalize(camelize(nameMatch[1])),
        prefixIdentifiers,
        hoistStatic,
        cacheHandlers,
        nodeTransforms,
        directiveTransforms,
        transformHoist,
        isBuiltInComponent,
        isCustomElement,
        expressionPlugins,
        scopeId,
        slotted,
        ssr,
        ssrCssVars,
        bindingMetadata,
        inline,
        isTS,
        onError,
        // state
        root,
        helpers: new Map(),
        components: new Set(),
        directives: new Set(),
        hoists: [],
        imports: [],
        constantCache: new Map(),
        temps: 0,
        cached: 0,
        identifiers: Object.create(null),
        scopes: {
            vFor: 0,
            vSlot: 0,
            vPre: 0,
            vOnce: 0
        },
        parent: null,
        currentNode: root,
        childIndex: 0,
        // methods
        helper(name) {
            const count = context.helpers.get(name) || 0;
            context.helpers.set(name, count + 1);
            return name;
        },
        removeHelper(name) {
            const count = context.helpers.get(name);
            if (count) {
                const currentCount = count - 1;
                if (!currentCount) {
                    context.helpers.delete(name);
                }
                else {
                    context.helpers.set(name, currentCount);
                }
            }
        },
        helperString(name) {
            return `_${helperNameMap[context.helper(name)]}`;
        },
        replaceNode(node) {
            /* istanbul ignore if */
            {
                if (!context.currentNode) {
                    throw new Error(`Node being replaced is already removed.`);
                }
                if (!context.parent) {
                    throw new Error(`Cannot replace root node.`);
                }
            }
            context.parent.children[context.childIndex] = context.currentNode = node;
        },
        removeNode(node) {
            if (!context.parent) {
                throw new Error(`Cannot remove root node.`);
            }
            const list = context.parent.children;
            const removalIndex = node
                ? list.indexOf(node)
                : context.currentNode
                    ? context.childIndex
                    : -1;
            /* istanbul ignore if */
            if (removalIndex < 0) {
                throw new Error(`node being removed is not a child of current parent`);
            }
            if (!node || node === context.currentNode) {
                // current node removed
                context.currentNode = null;
                context.onNodeRemoved();
            }
            else {
                // sibling node removed
                if (context.childIndex > removalIndex) {
                    context.childIndex--;
                    context.onNodeRemoved();
                }
            }
            context.parent.children.splice(removalIndex, 1);
        },
        onNodeRemoved: () => { },
        addIdentifiers(exp) {
            // identifier tracking only happens in non-browser builds.
            {
                if (isString(exp)) {
                    addId(exp);
                }
                else if (exp.identifiers) {
                    exp.identifiers.forEach(addId);
                }
                else if (exp.type === 4 /* SIMPLE_EXPRESSION */) {
                    addId(exp.content);
                }
            }
        },
        removeIdentifiers(exp) {
            {
                if (isString(exp)) {
                    removeId(exp);
                }
                else if (exp.identifiers) {
                    exp.identifiers.forEach(removeId);
                }
                else if (exp.type === 4 /* SIMPLE_EXPRESSION */) {
                    removeId(exp.content);
                }
            }
        },
        hoist(exp) {
            context.hoists.push(exp);
            const identifier = createSimpleExpression(`_hoisted_${context.hoists.length}`, false, exp.loc, 2 /* CAN_HOIST */);
            identifier.hoisted = exp;
            return identifier;
        },
        cache(exp, isVNode = false) {
            return createCacheExpression(++context.cached, exp, isVNode);
        }
    };
    function addId(id) {
        const { identifiers } = context;
        if (identifiers[id] === undefined) {
            identifiers[id] = 0;
        }
        identifiers[id]++;
    }
    function removeId(id) {
        context.identifiers[id]--;
    }
    return context;
}
function transform(root, options) {
    const context = createTransformContext(root, options);
    traverseNode(root, context);
    if (options.hoistStatic) {
        hoistStatic(root, context);
    }
    if (!options.ssr) {
        createRootCodegen(root, context);
    }
    // finalize meta information
    root.helpers = [...context.helpers.keys()];
    root.components = [...context.components];
    root.directives = [...context.directives];
    root.imports = context.imports;
    root.hoists = context.hoists;
    root.temps = context.temps;
    root.cached = context.cached;
}
function createRootCodegen(root, context) {
    const { helper, removeHelper } = context;
    const { children } = root;
    if (children.length === 1) {
        const child = children[0];
        // if the single child is an element, turn it into a block.
        if (isSingleElementRoot(root, child) && child.codegenNode) {
            // single element root is never hoisted so codegenNode will never be
            // SimpleExpressionNode
            const codegenNode = child.codegenNode;
            if (codegenNode.type === 13 /* VNODE_CALL */) {
                if (!codegenNode.isBlock) {
                    removeHelper(CREATE_VNODE);
                    codegenNode.isBlock = true;
                    helper(OPEN_BLOCK);
                    helper(CREATE_BLOCK);
                }
            }
            root.codegenNode = codegenNode;
        }
        else {
            // - single <slot/>, IfNode, ForNode: already blocks.
            // - single text node: always patched.
            // root codegen falls through via genNode()
            root.codegenNode = child;
        }
    }
    else if (children.length > 1) {
        // root has multiple nodes - return a fragment block.
        let patchFlag = 64 /* STABLE_FRAGMENT */;
        let patchFlagText = PatchFlagNames[64 /* STABLE_FRAGMENT */];
        // check if the fragment actually contains a single valid child with
        // the rest being comments
        if (children.filter(c => c.type !== 3 /* COMMENT */).length === 1) {
            patchFlag |= 2048 /* DEV_ROOT_FRAGMENT */;
            patchFlagText += `, ${PatchFlagNames[2048 /* DEV_ROOT_FRAGMENT */]}`;
        }
        root.codegenNode = createVNodeCall(context, helper(FRAGMENT), undefined, root.children, patchFlag + (` /* ${patchFlagText} */` ), undefined, undefined, true);
    }
    else ;
}
function traverseChildren(parent, context) {
    let i = 0;
    const nodeRemoved = () => {
        i--;
    };
    for (; i < parent.children.length; i++) {
        const child = parent.children[i];
        if (isString(child))
            continue;
        context.parent = parent;
        context.childIndex = i;
        context.onNodeRemoved = nodeRemoved;
        traverseNode(child, context);
    }
}
function traverseNode(node, context) {
    context.currentNode = node;
    // apply transform plugins
    const { nodeTransforms } = context;
    const exitFns = [];
    for (let i = 0; i < nodeTransforms.length; i++) {
        const onExit = nodeTransforms[i](node, context);
        if (onExit) {
            if (isArray(onExit)) {
                exitFns.push(...onExit);
            }
            else {
                exitFns.push(onExit);
            }
        }
        if (!context.currentNode) {
            // node was removed
            return;
        }
        else {
            // node may have been replaced
            node = context.currentNode;
        }
    }
    switch (node.type) {
        case 3 /* COMMENT */:
            if (!context.ssr) {
                // inject import for the Comment symbol, which is needed for creating
                // comment nodes with `createVNode`
                context.helper(CREATE_COMMENT);
            }
            break;
        case 5 /* INTERPOLATION */:
            // no need to traverse, but we need to inject toString helper
            if (!context.ssr) {
                context.helper(TO_DISPLAY_STRING);
            }
            break;
        // for container types, further traverse downwards
        case 9 /* IF */:
            for (let i = 0; i < node.branches.length; i++) {
                traverseNode(node.branches[i], context);
            }
            break;
        case 10 /* IF_BRANCH */:
        case 11 /* FOR */:
        case 1 /* ELEMENT */:
        case 0 /* ROOT */:
            traverseChildren(node, context);
            break;
    }
    // exit transforms
    context.currentNode = node;
    let i = exitFns.length;
    while (i--) {
        exitFns[i]();
    }
}
function createStructuralDirectiveTransform(name, fn) {
    const matches = isString(name)
        ? (n) => n === name
        : (n) => name.test(n);
    return (node, context) => {
        if (node.type === 1 /* ELEMENT */) {
            const { props } = node;
            // structural directive transforms are not concerned with slots
            // as they are handled separately in vSlot.ts
            if (node.tagType === 3 /* TEMPLATE */ && props.some(isVSlot)) {
                return;
            }
            const exitFns = [];
            for (let i = 0; i < props.length; i++) {
                const prop = props[i];
                if (prop.type === 7 /* DIRECTIVE */ && matches(prop.name)) {
                    // structural directives are removed to avoid infinite recursion
                    // also we remove them *before* applying so that it can further
                    // traverse itself in case it moves the node around
                    props.splice(i, 1);
                    i--;
                    const onExit = fn(node, prop, context);
                    if (onExit)
                        exitFns.push(onExit);
                }
            }
            return exitFns;
        }
    };
}

const PURE_ANNOTATION = `/*#__PURE__*/`;
const WITH_ID = `_withId`;
function createCodegenContext(ast, { mode = 'function', prefixIdentifiers = mode === 'module', sourceMap: sourceMap$1 = false, filename = `template.vue.html`, scopeId = null, optimizeImports = false, runtimeGlobalName = `Vue`, runtimeModuleName = `vue`, ssr = false }) {
    const context = {
        mode,
        prefixIdentifiers,
        sourceMap: sourceMap$1,
        filename,
        scopeId,
        optimizeImports,
        runtimeGlobalName,
        runtimeModuleName,
        ssr,
        source: ast.loc.source,
        code: ``,
        column: 1,
        line: 1,
        offset: 0,
        indentLevel: 0,
        pure: false,
        map: undefined,
        helper(key) {
            return `_${helperNameMap[key]}`;
        },
        push(code, node) {
            context.code += code;
            if (context.map) {
                if (node) {
                    let name;
                    if (node.type === 4 /* SIMPLE_EXPRESSION */ && !node.isStatic) {
                        const content = node.content.replace(/^_ctx\./, '');
                        if (content !== node.content && isSimpleIdentifier(content)) {
                            name = content;
                        }
                    }
                    addMapping(node.loc.start, name);
                }
                advancePositionWithMutation(context, code);
                if (node && node.loc !== locStub) {
                    addMapping(node.loc.end);
                }
            }
        },
        indent() {
            newline(++context.indentLevel);
        },
        deindent(withoutNewLine = false) {
            if (withoutNewLine) {
                --context.indentLevel;
            }
            else {
                newline(--context.indentLevel);
            }
        },
        newline() {
            newline(context.indentLevel);
        }
    };
    function newline(n) {
        context.push('\n' + `  `.repeat(n));
    }
    function addMapping(loc, name) {
        context.map.addMapping({
            name,
            source: context.filename,
            original: {
                line: loc.line,
                column: loc.column - 1 // source-map column is 0 based
            },
            generated: {
                line: context.line,
                column: context.column - 1
            }
        });
    }
    if (sourceMap$1) {
        // lazy require source-map implementation, only in non-browser builds
        context.map = new sourceMap.SourceMapGenerator();
        context.map.setSourceContent(filename, context.source);
    }
    return context;
}
function generate(ast, options = {}) {
    const context = createCodegenContext(ast, options);
    if (options.onContextCreated)
        options.onContextCreated(context);
    const { mode, push, prefixIdentifiers, indent, deindent, newline, scopeId, ssr } = context;
    const hasHelpers = ast.helpers.length > 0;
    const useWithBlock = !prefixIdentifiers && mode !== 'module';
    const genScopeId = scopeId != null && mode === 'module';
    const isSetupInlined = !!options.inline;
    // preambles
    // in setup() inline mode, the preamble is generated in a sub context
    // and returned separately.
    const preambleContext = isSetupInlined
        ? createCodegenContext(ast, options)
        : context;
    if (mode === 'module') {
        genModulePreamble(ast, preambleContext, genScopeId, isSetupInlined);
    }
    else {
        genFunctionPreamble(ast, preambleContext);
    }
    // enter render function
    const functionName = ssr ? `ssrRender` : `render`;
    const args = ssr ? ['_ctx', '_push', '_parent', '_attrs'] : ['_ctx', '_cache'];
    if (options.bindingMetadata && !options.inline) {
        // binding optimization args
        args.push('$props', '$setup', '$data', '$options');
    }
    const signature = options.isTS
        ? args.map(arg => `${arg}: any`).join(',')
        : args.join(', ');
    if (genScopeId && !isSetupInlined) {
        // root-level _withId wrapping is no longer necessary after 3.0.8 and is
        // a noop, it's only kept so that code compiled with 3.0.8+ can run with
        // runtime < 3.0.8.
        // TODO: consider removing in 3.1
        push(`const ${functionName} = ${PURE_ANNOTATION}${WITH_ID}(`);
    }
    if (isSetupInlined || genScopeId) {
        push(`(${signature}) => {`);
    }
    else {
        push(`function ${functionName}(${signature}) {`);
    }
    indent();
    if (useWithBlock) {
        push(`with (_ctx) {`);
        indent();
        // function mode const declarations should be inside with block
        // also they should be renamed to avoid collision with user properties
        if (hasHelpers) {
            push(`const { ${ast.helpers
                .map(s => `${helperNameMap[s]}: _${helperNameMap[s]}`)
                .join(', ')} } = _Vue`);
            push(`\n`);
            newline();
        }
    }
    // generate asset resolution statements
    if (ast.components.length) {
        genAssets(ast.components, 'component', context);
        if (ast.directives.length || ast.temps > 0) {
            newline();
        }
    }
    if (ast.directives.length) {
        genAssets(ast.directives, 'directive', context);
        if (ast.temps > 0) {
            newline();
        }
    }
    if (ast.temps > 0) {
        push(`let `);
        for (let i = 0; i < ast.temps; i++) {
            push(`${i > 0 ? `, ` : ``}_temp${i}`);
        }
    }
    if (ast.components.length || ast.directives.length || ast.temps) {
        push(`\n`);
        newline();
    }
    // generate the VNode tree expression
    if (!ssr) {
        push(`return `);
    }
    if (ast.codegenNode) {
        genNode(ast.codegenNode, context);
    }
    else {
        push(`null`);
    }
    if (useWithBlock) {
        deindent();
        push(`}`);
    }
    deindent();
    push(`}`);
    if (genScopeId && !isSetupInlined) {
        push(`)`);
    }
    return {
        ast,
        code: context.code,
        preamble: isSetupInlined ? preambleContext.code : ``,
        // SourceMapGenerator does have toJSON() method but it's not in the types
        map: context.map ? context.map.toJSON() : undefined
    };
}
function genFunctionPreamble(ast, context) {
    const { ssr, prefixIdentifiers, push, newline, runtimeModuleName, runtimeGlobalName } = context;
    const VueBinding = ssr
        ? `require(${JSON.stringify(runtimeModuleName)})`
        : runtimeGlobalName;
    const aliasHelper = (s) => `${helperNameMap[s]}: _${helperNameMap[s]}`;
    // Generate const declaration for helpers
    // In prefix mode, we place the const declaration at top so it's done
    // only once; But if we not prefixing, we place the declaration inside the
    // with block so it doesn't incur the `in` check cost for every helper access.
    if (ast.helpers.length > 0) {
        if (prefixIdentifiers) {
            push(`const { ${ast.helpers.map(aliasHelper).join(', ')} } = ${VueBinding}\n`);
        }
        else {
            // "with" mode.
            // save Vue in a separate variable to avoid collision
            push(`const _Vue = ${VueBinding}\n`);
            // in "with" mode, helpers are declared inside the with block to avoid
            // has check cost, but hoists are lifted out of the function - we need
            // to provide the helper here.
            if (ast.hoists.length) {
                const staticHelpers = [
                    CREATE_VNODE,
                    CREATE_COMMENT,
                    CREATE_TEXT,
                    CREATE_STATIC
                ]
                    .filter(helper => ast.helpers.includes(helper))
                    .map(aliasHelper)
                    .join(', ');
                push(`const { ${staticHelpers} } = _Vue\n`);
            }
        }
    }
    // generate variables for ssr helpers
    if (ast.ssrHelpers && ast.ssrHelpers.length) {
        // ssr guarantees prefixIdentifier: true
        push(`const { ${ast.ssrHelpers
            .map(aliasHelper)
            .join(', ')} } = require("@vue/server-renderer")\n`);
    }
    genHoists(ast.hoists, context);
    newline();
    push(`return `);
}
function genModulePreamble(ast, context, genScopeId, inline) {
    const { push, newline, optimizeImports, runtimeModuleName, scopeId, helper } = context;
    if (genScopeId) {
        ast.helpers.push(WITH_SCOPE_ID);
        if (ast.hoists.length) {
            ast.helpers.push(PUSH_SCOPE_ID, POP_SCOPE_ID);
        }
    }
    // generate import statements for helpers
    if (ast.helpers.length) {
        if (optimizeImports) {
            // when bundled with webpack with code-split, calling an import binding
            // as a function leads to it being wrapped with `Object(a.b)` or `(0,a.b)`,
            // incurring both payload size increase and potential perf overhead.
            // therefore we assign the imports to variables (which is a constant ~50b
            // cost per-component instead of scaling with template size)
            push(`import { ${ast.helpers
                .map(s => helperNameMap[s])
                .join(', ')} } from ${JSON.stringify(runtimeModuleName)}\n`);
            push(`\n// Binding optimization for webpack code-split\nconst ${ast.helpers
                .map(s => `_${helperNameMap[s]} = ${helperNameMap[s]}`)
                .join(', ')}\n`);
        }
        else {
            push(`import { ${ast.helpers
                .map(s => `${helperNameMap[s]} as _${helperNameMap[s]}`)
                .join(', ')} } from ${JSON.stringify(runtimeModuleName)}\n`);
        }
    }
    if (ast.ssrHelpers && ast.ssrHelpers.length) {
        push(`import { ${ast.ssrHelpers
            .map(s => `${helperNameMap[s]} as _${helperNameMap[s]}`)
            .join(', ')} } from "@vue/server-renderer"\n`);
    }
    if (ast.imports.length) {
        genImports(ast.imports, context);
        newline();
    }
    // we technically don't need this anymore since `withCtx` already sets the
    // correct scopeId, but this is necessary for backwards compat
    // TODO: consider removing in 3.1
    if (genScopeId) {
        push(`const ${WITH_ID} = ${PURE_ANNOTATION}${helper(WITH_SCOPE_ID)}("${scopeId}")`);
        newline();
    }
    genHoists(ast.hoists, context);
    newline();
    if (!inline) {
        push(`export `);
    }
}
function genAssets(assets, type, { helper, push, newline }) {
    const resolver = helper(type === 'component' ? RESOLVE_COMPONENT : RESOLVE_DIRECTIVE);
    for (let i = 0; i < assets.length; i++) {
        let id = assets[i];
        // potential component implicit self-reference inferred from SFC filename
        const maybeSelfReference = id.endsWith('__self');
        if (maybeSelfReference) {
            id = id.slice(0, -6);
        }
        push(`const ${toValidAssetId(id, type)} = ${resolver}(${JSON.stringify(id)}${maybeSelfReference ? `, true` : ``})`);
        if (i < assets.length - 1) {
            newline();
        }
    }
}
function genHoists(hoists, context) {
    if (!hoists.length) {
        return;
    }
    context.pure = true;
    const { push, newline, helper, scopeId, mode } = context;
    const genScopeId = scopeId != null && mode !== 'function';
    newline();
    // push scope Id before initializing hoisted vnodes so that these vnodes
    // get the proper scopeId as well.
    if (genScopeId) {
        push(`${helper(PUSH_SCOPE_ID)}("${scopeId}")`);
        newline();
    }
    hoists.forEach((exp, i) => {
        if (exp) {
            push(`const _hoisted_${i + 1} = `);
            genNode(exp, context);
            newline();
        }
    });
    if (genScopeId) {
        push(`${helper(POP_SCOPE_ID)}()`);
        newline();
    }
    context.pure = false;
}
function genImports(importsOptions, context) {
    if (!importsOptions.length) {
        return;
    }
    importsOptions.forEach(imports => {
        context.push(`import `);
        genNode(imports.exp, context);
        context.push(` from '${imports.path}'`);
        context.newline();
    });
}
function isText$1(n) {
    return (isString(n) ||
        n.type === 4 /* SIMPLE_EXPRESSION */ ||
        n.type === 2 /* TEXT */ ||
        n.type === 5 /* INTERPOLATION */ ||
        n.type === 8 /* COMPOUND_EXPRESSION */);
}
function genNodeListAsArray(nodes, context) {
    const multilines = nodes.length > 3 ||
        (nodes.some(n => isArray(n) || !isText$1(n)));
    context.push(`[`);
    multilines && context.indent();
    genNodeList(nodes, context, multilines);
    multilines && context.deindent();
    context.push(`]`);
}
function genNodeList(nodes, context, multilines = false, comma = true) {
    const { push, newline } = context;
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (isString(node)) {
            push(node);
        }
        else if (isArray(node)) {
            genNodeListAsArray(node, context);
        }
        else {
            genNode(node, context);
        }
        if (i < nodes.length - 1) {
            if (multilines) {
                comma && push(',');
                newline();
            }
            else {
                comma && push(', ');
            }
        }
    }
}
function genNode(node, context) {
    if (isString(node)) {
        context.push(node);
        return;
    }
    if (isSymbol(node)) {
        context.push(context.helper(node));
        return;
    }
    switch (node.type) {
        case 1 /* ELEMENT */:
        case 9 /* IF */:
        case 11 /* FOR */:
            assert(node.codegenNode != null, `Codegen node is missing for element/if/for node. ` +
                    `Apply appropriate transforms first.`);
            genNode(node.codegenNode, context);
            break;
        case 2 /* TEXT */:
            genText(node, context);
            break;
        case 4 /* SIMPLE_EXPRESSION */:
            genExpression(node, context);
            break;
        case 5 /* INTERPOLATION */:
            genInterpolation(node, context);
            break;
        case 12 /* TEXT_CALL */:
            genNode(node.codegenNode, context);
            break;
        case 8 /* COMPOUND_EXPRESSION */:
            genCompoundExpression(node, context);
            break;
        case 3 /* COMMENT */:
            genComment(node, context);
            break;
        case 13 /* VNODE_CALL */:
            genVNodeCall(node, context);
            break;
        case 14 /* JS_CALL_EXPRESSION */:
            genCallExpression(node, context);
            break;
        case 15 /* JS_OBJECT_EXPRESSION */:
            genObjectExpression(node, context);
            break;
        case 17 /* JS_ARRAY_EXPRESSION */:
            genArrayExpression(node, context);
            break;
        case 18 /* JS_FUNCTION_EXPRESSION */:
            genFunctionExpression(node, context);
            break;
        case 19 /* JS_CONDITIONAL_EXPRESSION */:
            genConditionalExpression(node, context);
            break;
        case 20 /* JS_CACHE_EXPRESSION */:
            genCacheExpression(node, context);
            break;
        // SSR only types
        case 21 /* JS_BLOCK_STATEMENT */:
            genNodeList(node.body, context, true, false);
            break;
        case 22 /* JS_TEMPLATE_LITERAL */:
            genTemplateLiteral(node, context);
            break;
        case 23 /* JS_IF_STATEMENT */:
            genIfStatement(node, context);
            break;
        case 24 /* JS_ASSIGNMENT_EXPRESSION */:
            genAssignmentExpression(node, context);
            break;
        case 25 /* JS_SEQUENCE_EXPRESSION */:
            genSequenceExpression(node, context);
            break;
        case 26 /* JS_RETURN_STATEMENT */:
            genReturnStatement(node, context);
            break;
        /* istanbul ignore next */
        case 10 /* IF_BRANCH */:
            // noop
            break;
        default:
            {
                assert(false, `unhandled codegen node type: ${node.type}`);
                // make sure we exhaust all possible types
                const exhaustiveCheck = node;
                return exhaustiveCheck;
            }
    }
}
function genText(node, context) {
    context.push(JSON.stringify(node.content), node);
}
function genExpression(node, context) {
    const { content, isStatic } = node;
    context.push(isStatic ? JSON.stringify(content) : content, node);
}
function genInterpolation(node, context) {
    const { push, helper, pure } = context;
    if (pure)
        push(PURE_ANNOTATION);
    push(`${helper(TO_DISPLAY_STRING)}(`);
    genNode(node.content, context);
    push(`)`);
}
function genCompoundExpression(node, context) {
    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (isString(child)) {
            context.push(child);
        }
        else {
            genNode(child, context);
        }
    }
}
function genExpressionAsPropertyKey(node, context) {
    const { push } = context;
    if (node.type === 8 /* COMPOUND_EXPRESSION */) {
        push(`[`);
        genCompoundExpression(node, context);
        push(`]`);
    }
    else if (node.isStatic) {
        // only quote keys if necessary
        const text = isSimpleIdentifier(node.content)
            ? node.content
            : JSON.stringify(node.content);
        push(text, node);
    }
    else {
        push(`[${node.content}]`, node);
    }
}
function genComment(node, context) {
    {
        const { push, helper, pure } = context;
        if (pure) {
            push(PURE_ANNOTATION);
        }
        push(`${helper(CREATE_COMMENT)}(${JSON.stringify(node.content)})`, node);
    }
}
function genVNodeCall(node, context) {
    const { push, helper, pure } = context;
    const { tag, props, children, patchFlag, dynamicProps, directives, isBlock, disableTracking } = node;
    if (directives) {
        push(helper(WITH_DIRECTIVES) + `(`);
    }
    if (isBlock) {
        push(`(${helper(OPEN_BLOCK)}(${disableTracking ? `true` : ``}), `);
    }
    if (pure) {
        push(PURE_ANNOTATION);
    }
    push(helper(isBlock ? CREATE_BLOCK : CREATE_VNODE) + `(`, node);
    genNodeList(genNullableArgs([tag, props, children, patchFlag, dynamicProps]), context);
    push(`)`);
    if (isBlock) {
        push(`)`);
    }
    if (directives) {
        push(`, `);
        genNode(directives, context);
        push(`)`);
    }
}
function genNullableArgs(args) {
    let i = args.length;
    while (i--) {
        if (args[i] != null)
            break;
    }
    return args.slice(0, i + 1).map(arg => arg || `null`);
}
// JavaScript
function genCallExpression(node, context) {
    const { push, helper, pure } = context;
    const callee = isString(node.callee) ? node.callee : helper(node.callee);
    if (pure) {
        push(PURE_ANNOTATION);
    }
    push(callee + `(`, node);
    genNodeList(node.arguments, context);
    push(`)`);
}
function genObjectExpression(node, context) {
    const { push, indent, deindent, newline } = context;
    const { properties } = node;
    if (!properties.length) {
        push(`{}`, node);
        return;
    }
    const multilines = properties.length > 1 ||
        (properties.some(p => p.value.type !== 4 /* SIMPLE_EXPRESSION */));
    push(multilines ? `{` : `{ `);
    multilines && indent();
    for (let i = 0; i < properties.length; i++) {
        const { key, value } = properties[i];
        // key
        genExpressionAsPropertyKey(key, context);
        push(`: `);
        // value
        genNode(value, context);
        if (i < properties.length - 1) {
            // will only reach this if it's multilines
            push(`,`);
            newline();
        }
    }
    multilines && deindent();
    push(multilines ? `}` : ` }`);
}
function genArrayExpression(node, context) {
    genNodeListAsArray(node.elements, context);
}
function genFunctionExpression(node, context) {
    const { push, indent, deindent, scopeId, mode } = context;
    const { params, returns, body, newline, isSlot } = node;
    // slot functions also need to push scopeId before rendering its content
    const genScopeId = isSlot && scopeId != null && mode !== 'function';
    if (isSlot) {
        // wrap slot functions with owner context
        push(genScopeId ? `${WITH_ID}(` : `_${helperNameMap[WITH_CTX]}(`);
    }
    push(`(`, node);
    if (isArray(params)) {
        genNodeList(params, context);
    }
    else if (params) {
        genNode(params, context);
    }
    push(`) => `);
    if (newline || body) {
        push(`{`);
        indent();
    }
    if (returns) {
        if (newline) {
            push(`return `);
        }
        if (isArray(returns)) {
            genNodeListAsArray(returns, context);
        }
        else {
            genNode(returns, context);
        }
    }
    else if (body) {
        genNode(body, context);
    }
    if (newline || body) {
        deindent();
        push(`}`);
    }
    if (isSlot) {
        push(`)`);
    }
}
function genConditionalExpression(node, context) {
    const { test, consequent, alternate, newline: needNewline } = node;
    const { push, indent, deindent, newline } = context;
    if (test.type === 4 /* SIMPLE_EXPRESSION */) {
        const needsParens = !isSimpleIdentifier(test.content);
        needsParens && push(`(`);
        genExpression(test, context);
        needsParens && push(`)`);
    }
    else {
        push(`(`);
        genNode(test, context);
        push(`)`);
    }
    needNewline && indent();
    context.indentLevel++;
    needNewline || push(` `);
    push(`? `);
    genNode(consequent, context);
    context.indentLevel--;
    needNewline && newline();
    needNewline || push(` `);
    push(`: `);
    const isNested = alternate.type === 19 /* JS_CONDITIONAL_EXPRESSION */;
    if (!isNested) {
        context.indentLevel++;
    }
    genNode(alternate, context);
    if (!isNested) {
        context.indentLevel--;
    }
    needNewline && deindent(true /* without newline */);
}
function genCacheExpression(node, context) {
    const { push, helper, indent, deindent, newline } = context;
    push(`_cache[${node.index}] || (`);
    if (node.isVNode) {
        indent();
        push(`${helper(SET_BLOCK_TRACKING)}(-1),`);
        newline();
    }
    push(`_cache[${node.index}] = `);
    genNode(node.value, context);
    if (node.isVNode) {
        push(`,`);
        newline();
        push(`${helper(SET_BLOCK_TRACKING)}(1),`);
        newline();
        push(`_cache[${node.index}]`);
        deindent();
    }
    push(`)`);
}
function genTemplateLiteral(node, context) {
    const { push, indent, deindent } = context;
    push('`');
    const l = node.elements.length;
    const multilines = l > 3;
    for (let i = 0; i < l; i++) {
        const e = node.elements[i];
        if (isString(e)) {
            push(e.replace(/(`|\$|\\)/g, '\\$1'));
        }
        else {
            push('${');
            if (multilines)
                indent();
            genNode(e, context);
            if (multilines)
                deindent();
            push('}');
        }
    }
    push('`');
}
function genIfStatement(node, context) {
    const { push, indent, deindent } = context;
    const { test, consequent, alternate } = node;
    push(`if (`);
    genNode(test, context);
    push(`) {`);
    indent();
    genNode(consequent, context);
    deindent();
    push(`}`);
    if (alternate) {
        push(` else `);
        if (alternate.type === 23 /* JS_IF_STATEMENT */) {
            genIfStatement(alternate, context);
        }
        else {
            push(`{`);
            indent();
            genNode(alternate, context);
            deindent();
            push(`}`);
        }
    }
}
function genAssignmentExpression(node, context) {
    genNode(node.left, context);
    context.push(` = `);
    genNode(node.right, context);
}
function genSequenceExpression(node, context) {
    context.push(`(`);
    genNodeList(node.expressions, context);
    context.push(`)`);
}
function genReturnStatement({ returns }, context) {
    context.push(`return `);
    if (isArray(returns)) {
        genNodeListAsArray(returns, context);
    }
    else {
        genNode(returns, context);
    }
}

const isLiteralWhitelisted = /*#__PURE__*/ makeMap('true,false,null,this');
const transformExpression = (node, context) => {
    if (node.type === 5 /* INTERPOLATION */) {
        node.content = processExpression(node.content, context);
    }
    else if (node.type === 1 /* ELEMENT */) {
        // handle directives on element
        for (let i = 0; i < node.props.length; i++) {
            const dir = node.props[i];
            // do not process for v-on & v-for since they are special handled
            if (dir.type === 7 /* DIRECTIVE */ && dir.name !== 'for') {
                const exp = dir.exp;
                const arg = dir.arg;
                // do not process exp if this is v-on:arg - we need special handling
                // for wrapping inline statements.
                if (exp &&
                    exp.type === 4 /* SIMPLE_EXPRESSION */ &&
                    !(dir.name === 'on' && arg)) {
                    dir.exp = processExpression(exp, context, 
                    // slot args must be processed as function params
                    dir.name === 'slot');
                }
                if (arg && arg.type === 4 /* SIMPLE_EXPRESSION */ && !arg.isStatic) {
                    dir.arg = processExpression(arg, context);
                }
            }
        }
    }
};
// Important: since this function uses Node.js only dependencies, it should
// always be used with a leading !false check so that it can be
// tree-shaken from the browser build.
function processExpression(node, context, 
// some expressions like v-slot props & v-for aliases should be parsed as
// function params
asParams = false, 
// v-on handler values may contain multiple statements
asRawStatements = false) {
    if (!context.prefixIdentifiers || !node.content.trim()) {
        return node;
    }
    const { inline, bindingMetadata } = context;
    const rewriteIdentifier = (raw, parent, id) => {
        const type = hasOwn(bindingMetadata, raw) && bindingMetadata[raw];
        if (inline) {
            // x = y
            const isAssignmentLVal = parent && parent.type === 'AssignmentExpression' && parent.left === id;
            // x++
            const isUpdateArg = parent && parent.type === 'UpdateExpression' && parent.argument === id;
            // ({ x } = y)
            const isDestructureAssignment = parent && isInDestructureAssignment(parent, parentStack);
            if (type === "setup-const" /* SETUP_CONST */) {
                return raw;
            }
            else if (type === "setup-ref" /* SETUP_REF */) {
                return `${raw}.value`;
            }
            else if (type === "setup-maybe-ref" /* SETUP_MAYBE_REF */) {
                // const binding that may or may not be ref
                // if it's not a ref, then assignments don't make sense -
                // so we ignore the non-ref assignment case and generate code
                // that assumes the value to be a ref for more efficiency
                return isAssignmentLVal || isUpdateArg || isDestructureAssignment
                    ? `${raw}.value`
                    : `${context.helperString(UNREF)}(${raw})`;
            }
            else if (type === "setup-let" /* SETUP_LET */) {
                if (isAssignmentLVal) {
                    // let binding.
                    // this is a bit more tricky as we need to cover the case where
                    // let is a local non-ref value, and we need to replicate the
                    // right hand side value.
                    // x = y --> isRef(x) ? x.value = y : x = y
                    const rVal = parent.right;
                    const rExp = rawExp.slice(rVal.start - 1, rVal.end - 1);
                    const rExpString = stringifyExpression(processExpression(createSimpleExpression(rExp, false), context));
                    return `${context.helperString(IS_REF)}(${raw})${context.isTS ? ` //@ts-ignore\n` : ``} ? ${raw}.value = ${rExpString} : ${raw}`;
                }
                else if (isUpdateArg) {
                    // make id replace parent in the code range so the raw update operator
                    // is removed
                    id.start = parent.start;
                    id.end = parent.end;
                    const { prefix: isPrefix, operator } = parent;
                    const prefix = isPrefix ? operator : ``;
                    const postfix = isPrefix ? `` : operator;
                    // let binding.
                    // x++ --> isRef(a) ? a.value++ : a++
                    return `${context.helperString(IS_REF)}(${raw})${context.isTS ? ` //@ts-ignore\n` : ``} ? ${prefix}${raw}.value${postfix} : ${prefix}${raw}${postfix}`;
                }
                else if (isDestructureAssignment) {
                    // TODO
                    // let binding in a destructure assignment - it's very tricky to
                    // handle both possible cases here without altering the original
                    // structure of the code, so we just assume it's not a ref here
                    // for now
                    return raw;
                }
                else {
                    return `${context.helperString(UNREF)}(${raw})`;
                }
            }
            else if (type === "props" /* PROPS */) {
                // use __props which is generated by compileScript so in ts mode
                // it gets correct type
                return `__props.${raw}`;
            }
        }
        else {
            if (type && type.startsWith('setup')) {
                // setup bindings in non-inline mode
                return `$setup.${raw}`;
            }
            else if (type) {
                return `$${type}.${raw}`;
            }
        }
        // fallback to ctx
        return `_ctx.${raw}`;
    };
    // fast path if expression is a simple identifier.
    const rawExp = node.content;
    // bail constant on parens (function invocation) and dot (member access)
    const bailConstant = rawExp.indexOf(`(`) > -1 || rawExp.indexOf('.') > 0;
    if (isSimpleIdentifier(rawExp)) {
        const isScopeVarReference = context.identifiers[rawExp];
        const isAllowedGlobal = isGloballyWhitelisted(rawExp);
        const isLiteral = isLiteralWhitelisted(rawExp);
        if (!asParams && !isScopeVarReference && !isAllowedGlobal && !isLiteral) {
            // const bindings exposed from setup can be skipped for patching but
            // cannot be hoisted to module scope
            if (bindingMetadata[node.content] === "setup-const" /* SETUP_CONST */) {
                node.constType = 1 /* CAN_SKIP_PATCH */;
            }
            node.content = rewriteIdentifier(rawExp);
        }
        else if (!isScopeVarReference) {
            if (isLiteral) {
                node.constType = 3 /* CAN_STRINGIFY */;
            }
            else {
                node.constType = 2 /* CAN_HOIST */;
            }
        }
        return node;
    }
    let ast;
    // exp needs to be parsed differently:
    // 1. Multiple inline statements (v-on, with presence of `;`): parse as raw
    //    exp, but make sure to pad with spaces for consistent ranges
    // 2. Expressions: wrap with parens (for e.g. object expressions)
    // 3. Function arguments (v-for, v-slot): place in a function argument position
    const source = asRawStatements
        ? ` ${rawExp} `
        : `(${rawExp})${asParams ? `=>{}` : ``}`;
    try {
        ast = parser.parse(source, {
            plugins: [...context.expressionPlugins, ...babelParserDefaultPlugins]
        }).program;
    }
    catch (e) {
        context.onError(createCompilerError(43 /* X_INVALID_EXPRESSION */, node.loc, undefined, e.message));
        return node;
    }
    const ids = [];
    const knownIds = Object.create(context.identifiers);
    const isDuplicate = (node) => ids.some(id => id.start === node.start);
    const parentStack = [];
    estreeWalker.walk(ast, {
        enter(node, parent) {
            parent && parentStack.push(parent);
            if (node.type === 'Identifier') {
                if (!isDuplicate(node)) {
                    const needPrefix = shouldPrefix(node, parent, parentStack);
                    if (!knownIds[node.name] && needPrefix) {
                        if (isStaticProperty(parent) && parent.shorthand) {
                            // property shorthand like { foo }, we need to add the key since
                            // we rewrite the value
                            node.prefix = `${node.name}: `;
                        }
                        node.name = rewriteIdentifier(node.name, parent, node);
                        ids.push(node);
                    }
                    else if (!isStaticPropertyKey(node, parent)) {
                        // The identifier is considered constant unless it's pointing to a
                        // scope variable (a v-for alias, or a v-slot prop)
                        if (!(needPrefix && knownIds[node.name]) && !bailConstant) {
                            node.isConstant = true;
                        }
                        // also generate sub-expressions for other identifiers for better
                        // source map support. (except for property keys which are static)
                        ids.push(node);
                    }
                }
            }
            else if (isFunction$1(node)) {
                // walk function expressions and add its arguments to known identifiers
                // so that we don't prefix them
                node.params.forEach(p => estreeWalker.walk(p, {
                    enter(child, parent) {
                        if (child.type === 'Identifier' &&
                            // do not record as scope variable if is a destructured key
                            !isStaticPropertyKey(child, parent) &&
                            // do not record if this is a default value
                            // assignment of a destructured variable
                            !(parent &&
                                parent.type === 'AssignmentPattern' &&
                                parent.right === child)) {
                            const { name } = child;
                            if (node.scopeIds && node.scopeIds.has(name)) {
                                return;
                            }
                            if (name in knownIds) {
                                knownIds[name]++;
                            }
                            else {
                                knownIds[name] = 1;
                            }
                            (node.scopeIds || (node.scopeIds = new Set())).add(name);
                        }
                    }
                }));
            }
        },
        leave(node, parent) {
            parent && parentStack.pop();
            if (node !== ast.body[0].expression && node.scopeIds) {
                node.scopeIds.forEach((id) => {
                    knownIds[id]--;
                    if (knownIds[id] === 0) {
                        delete knownIds[id];
                    }
                });
            }
        }
    });
    // We break up the compound expression into an array of strings and sub
    // expressions (for identifiers that have been prefixed). In codegen, if
    // an ExpressionNode has the `.children` property, it will be used instead of
    // `.content`.
    const children = [];
    ids.sort((a, b) => a.start - b.start);
    ids.forEach((id, i) => {
        // range is offset by -1 due to the wrapping parens when parsed
        const start = id.start - 1;
        const end = id.end - 1;
        const last = ids[i - 1];
        const leadingText = rawExp.slice(last ? last.end - 1 : 0, start);
        if (leadingText.length || id.prefix) {
            children.push(leadingText + (id.prefix || ``));
        }
        const source = rawExp.slice(start, end);
        children.push(createSimpleExpression(id.name, false, {
            source,
            start: advancePositionWithClone(node.loc.start, source, start),
            end: advancePositionWithClone(node.loc.start, source, end)
        }, id.isConstant ? 3 /* CAN_STRINGIFY */ : 0 /* NOT_CONSTANT */));
        if (i === ids.length - 1 && end < rawExp.length) {
            children.push(rawExp.slice(end));
        }
    });
    let ret;
    if (children.length) {
        ret = createCompoundExpression(children, node.loc);
    }
    else {
        ret = node;
        ret.constType = bailConstant
            ? 0 /* NOT_CONSTANT */
            : 3 /* CAN_STRINGIFY */;
    }
    ret.identifiers = Object.keys(knownIds);
    return ret;
}
const isFunction$1 = (node) => {
    return /Function(?:Expression|Declaration)$|Method$/.test(node.type);
};
const isStaticProperty = (node) => node &&
    (node.type === 'ObjectProperty' || node.type === 'ObjectMethod') &&
    !node.computed;
const isStaticPropertyKey = (node, parent) => isStaticProperty(parent) && parent.key === node;
function shouldPrefix(id, parent, parentStack) {
    // declaration id
    if ((parent.type === 'VariableDeclarator' ||
        parent.type === 'ClassDeclaration') &&
        parent.id === id) {
        return false;
    }
    if (isFunction$1(parent)) {
        // function decalration/expression id
        if (parent.id === id) {
            return false;
        }
        // params list
        if (parent.params.includes(id)) {
            return false;
        }
    }
    // property key
    // this also covers object destructure pattern
    if (isStaticPropertyKey(id, parent)) {
        return false;
    }
    // non-assignment array destructure pattern
    if (parent.type === 'ArrayPattern' &&
        !isInDestructureAssignment(parent, parentStack)) {
        return false;
    }
    // member expression property
    if ((parent.type === 'MemberExpression' ||
        parent.type === 'OptionalMemberExpression') &&
        parent.property === id &&
        !parent.computed) {
        return false;
    }
    // is a special keyword but parsed as identifier
    if (id.name === 'arguments') {
        return false;
    }
    // skip whitelisted globals
    if (isGloballyWhitelisted(id.name)) {
        return false;
    }
    // special case for webpack compilation
    if (id.name === 'require') {
        return false;
    }
    return true;
}
function isInDestructureAssignment(parent, parentStack) {
    if (parent &&
        (parent.type === 'ObjectProperty' || parent.type === 'ArrayPattern')) {
        let i = parentStack.length;
        while (i--) {
            const p = parentStack[i];
            if (p.type === 'AssignmentExpression') {
                return true;
            }
            else if (p.type !== 'ObjectProperty' && !p.type.endsWith('Pattern')) {
                break;
            }
        }
    }
    return false;
}
function stringifyExpression(exp) {
    if (isString(exp)) {
        return exp;
    }
    else if (exp.type === 4 /* SIMPLE_EXPRESSION */) {
        return exp.content;
    }
    else {
        return exp.children
            .map(stringifyExpression)
            .join('');
    }
}

const transformIf = createStructuralDirectiveTransform(/^(if|else|else-if)$/, (node, dir, context) => {
    return processIf(node, dir, context, (ifNode, branch, isRoot) => {
        // #1587: We need to dynamically increment the key based on the current
        // node's sibling nodes, since chained v-if/else branches are
        // rendered at the same depth
        const siblings = context.parent.children;
        let i = siblings.indexOf(ifNode);
        let key = 0;
        while (i-- >= 0) {
            const sibling = siblings[i];
            if (sibling && sibling.type === 9 /* IF */) {
                key += sibling.branches.length;
            }
        }
        // Exit callback. Complete the codegenNode when all children have been
        // transformed.
        return () => {
            if (isRoot) {
                ifNode.codegenNode = createCodegenNodeForBranch(branch, key, context);
            }
            else {
                // attach this branch's codegen node to the v-if root.
                const parentCondition = getParentCondition(ifNode.codegenNode);
                parentCondition.alternate = createCodegenNodeForBranch(branch, key + ifNode.branches.length - 1, context);
            }
        };
    });
});
// target-agnostic transform used for both Client and SSR
function processIf(node, dir, context, processCodegen) {
    if (dir.name !== 'else' &&
        (!dir.exp || !dir.exp.content.trim())) {
        const loc = dir.exp ? dir.exp.loc : node.loc;
        context.onError(createCompilerError(27 /* X_V_IF_NO_EXPRESSION */, dir.loc));
        dir.exp = createSimpleExpression(`true`, false, loc);
    }
    if (context.prefixIdentifiers && dir.exp) {
        // dir.exp can only be simple expression because vIf transform is applied
        // before expression transform.
        dir.exp = processExpression(dir.exp, context);
    }
    if (dir.name === 'if') {
        const branch = createIfBranch(node, dir);
        const ifNode = {
            type: 9 /* IF */,
            loc: node.loc,
            branches: [branch]
        };
        context.replaceNode(ifNode);
        if (processCodegen) {
            return processCodegen(ifNode, branch, true);
        }
    }
    else {
        // locate the adjacent v-if
        const siblings = context.parent.children;
        const comments = [];
        let i = siblings.indexOf(node);
        while (i-- >= -1) {
            const sibling = siblings[i];
            if (sibling && sibling.type === 3 /* COMMENT */) {
                context.removeNode(sibling);
                comments.unshift(sibling);
                continue;
            }
            if (sibling &&
                sibling.type === 2 /* TEXT */ &&
                !sibling.content.trim().length) {
                context.removeNode(sibling);
                continue;
            }
            if (sibling && sibling.type === 9 /* IF */) {
                // move the node to the if node's branches
                context.removeNode();
                const branch = createIfBranch(node, dir);
                if (comments.length) {
                    branch.children = [...comments, ...branch.children];
                }
                // check if user is forcing same key on different branches
                {
                    const key = branch.userKey;
                    if (key) {
                        sibling.branches.forEach(({ userKey }) => {
                            if (isSameKey(userKey, key)) {
                                context.onError(createCompilerError(28 /* X_V_IF_SAME_KEY */, branch.userKey.loc));
                            }
                        });
                    }
                }
                sibling.branches.push(branch);
                const onExit = processCodegen && processCodegen(sibling, branch, false);
                // since the branch was removed, it will not be traversed.
                // make sure to traverse here.
                traverseNode(branch, context);
                // call on exit
                if (onExit)
                    onExit();
                // make sure to reset currentNode after traversal to indicate this
                // node has been removed.
                context.currentNode = null;
            }
            else {
                context.onError(createCompilerError(29 /* X_V_ELSE_NO_ADJACENT_IF */, node.loc));
            }
            break;
        }
    }
}
function createIfBranch(node, dir) {
    return {
        type: 10 /* IF_BRANCH */,
        loc: node.loc,
        condition: dir.name === 'else' ? undefined : dir.exp,
        children: node.tagType === 3 /* TEMPLATE */ && !findDir(node, 'for')
            ? node.children
            : [node],
        userKey: findProp(node, `key`)
    };
}
function createCodegenNodeForBranch(branch, keyIndex, context) {
    if (branch.condition) {
        return createConditionalExpression(branch.condition, createChildrenCodegenNode(branch, keyIndex, context), 
        // make sure to pass in asBlock: true so that the comment node call
        // closes the current block.
        createCallExpression(context.helper(CREATE_COMMENT), [
            '"v-if"' ,
            'true'
        ]));
    }
    else {
        return createChildrenCodegenNode(branch, keyIndex, context);
    }
}
function createChildrenCodegenNode(branch, keyIndex, context) {
    const { helper, removeHelper } = context;
    const keyProperty = createObjectProperty(`key`, createSimpleExpression(`${keyIndex}`, false, locStub, 2 /* CAN_HOIST */));
    const { children } = branch;
    const firstChild = children[0];
    const needFragmentWrapper = children.length !== 1 || firstChild.type !== 1 /* ELEMENT */;
    if (needFragmentWrapper) {
        if (children.length === 1 && firstChild.type === 11 /* FOR */) {
            // optimize away nested fragments when child is a ForNode
            const vnodeCall = firstChild.codegenNode;
            injectProp(vnodeCall, keyProperty, context);
            return vnodeCall;
        }
        else {
            let patchFlag = 64 /* STABLE_FRAGMENT */;
            let patchFlagText = PatchFlagNames[64 /* STABLE_FRAGMENT */];
            // check if the fragment actually contains a single valid child with
            // the rest being comments
            if (children.filter(c => c.type !== 3 /* COMMENT */).length === 1) {
                patchFlag |= 2048 /* DEV_ROOT_FRAGMENT */;
                patchFlagText += `, ${PatchFlagNames[2048 /* DEV_ROOT_FRAGMENT */]}`;
            }
            return createVNodeCall(context, helper(FRAGMENT), createObjectExpression([keyProperty]), children, patchFlag + (` /* ${patchFlagText} */` ), undefined, undefined, true, false, branch.loc);
        }
    }
    else {
        const vnodeCall = firstChild
            .codegenNode;
        // Change createVNode to createBlock.
        if (vnodeCall.type === 13 /* VNODE_CALL */ && !vnodeCall.isBlock) {
            removeHelper(CREATE_VNODE);
            vnodeCall.isBlock = true;
            helper(OPEN_BLOCK);
            helper(CREATE_BLOCK);
        }
        // inject branch key
        injectProp(vnodeCall, keyProperty, context);
        return vnodeCall;
    }
}
function isSameKey(a, b) {
    if (!a || a.type !== b.type) {
        return false;
    }
    if (a.type === 6 /* ATTRIBUTE */) {
        if (a.value.content !== b.value.content) {
            return false;
        }
    }
    else {
        // directive
        const exp = a.exp;
        const branchExp = b.exp;
        if (exp.type !== branchExp.type) {
            return false;
        }
        if (exp.type !== 4 /* SIMPLE_EXPRESSION */ ||
            (exp.isStatic !== branchExp.isStatic ||
                exp.content !== branchExp.content)) {
            return false;
        }
    }
    return true;
}
function getParentCondition(node) {
    while (true) {
        if (node.type === 19 /* JS_CONDITIONAL_EXPRESSION */) {
            if (node.alternate.type === 19 /* JS_CONDITIONAL_EXPRESSION */) {
                node = node.alternate;
            }
            else {
                return node;
            }
        }
        else if (node.type === 20 /* JS_CACHE_EXPRESSION */) {
            node = node.value;
        }
    }
}

const transformFor = createStructuralDirectiveTransform('for', (node, dir, context) => {
    const { helper, removeHelper } = context;
    return processFor(node, dir, context, forNode => {
        // create the loop render function expression now, and add the
        // iterator on exit after all children have been traversed
        const renderExp = createCallExpression(helper(RENDER_LIST), [
            forNode.source
        ]);
        const keyProp = findProp(node, `key`);
        const keyProperty = keyProp
            ? createObjectProperty(`key`, keyProp.type === 6 /* ATTRIBUTE */
                ? createSimpleExpression(keyProp.value.content, true)
                : keyProp.exp)
            : null;
        if (context.prefixIdentifiers && keyProperty) {
            // #2085 process :key expression needs to be processed in order for it
            // to behave consistently for <template v-for> and <div v-for>.
            // In the case of `<template v-for>`, the node is discarded and never
            // traversed so its key expression won't be processed by the normal
            // transforms.
            keyProperty.value = processExpression(keyProperty.value, context);
        }
        const isStableFragment = forNode.source.type === 4 /* SIMPLE_EXPRESSION */ &&
            forNode.source.constType > 0 /* NOT_CONSTANT */;
        const fragmentFlag = isStableFragment
            ? 64 /* STABLE_FRAGMENT */
            : keyProp
                ? 128 /* KEYED_FRAGMENT */
                : 256 /* UNKEYED_FRAGMENT */;
        forNode.codegenNode = createVNodeCall(context, helper(FRAGMENT), undefined, renderExp, fragmentFlag +
            (` /* ${PatchFlagNames[fragmentFlag]} */` ), undefined, undefined, true /* isBlock */, !isStableFragment /* disableTracking */, node.loc);
        return () => {
            // finish the codegen now that all children have been traversed
            let childBlock;
            const isTemplate = isTemplateNode(node);
            const { children } = forNode;
            // check <template v-for> key placement
            if (isTemplate) {
                node.children.some(c => {
                    if (c.type === 1 /* ELEMENT */) {
                        const key = findProp(c, 'key');
                        if (key) {
                            context.onError(createCompilerError(32 /* X_V_FOR_TEMPLATE_KEY_PLACEMENT */, key.loc));
                            return true;
                        }
                    }
                });
            }
            const needFragmentWrapper = children.length !== 1 || children[0].type !== 1 /* ELEMENT */;
            const slotOutlet = isSlotOutlet(node)
                ? node
                : isTemplate &&
                    node.children.length === 1 &&
                    isSlotOutlet(node.children[0])
                    ? node.children[0] // api-extractor somehow fails to infer this
                    : null;
            if (slotOutlet) {
                // <slot v-for="..."> or <template v-for="..."><slot/></template>
                childBlock = slotOutlet.codegenNode;
                if (isTemplate && keyProperty) {
                    // <template v-for="..." :key="..."><slot/></template>
                    // we need to inject the key to the renderSlot() call.
                    // the props for renderSlot is passed as the 3rd argument.
                    injectProp(childBlock, keyProperty, context);
                }
            }
            else if (needFragmentWrapper) {
                // <template v-for="..."> with text or multi-elements
                // should generate a fragment block for each loop
                childBlock = createVNodeCall(context, helper(FRAGMENT), keyProperty ? createObjectExpression([keyProperty]) : undefined, node.children, 64 /* STABLE_FRAGMENT */ +
                    (` /* ${PatchFlagNames[64 /* STABLE_FRAGMENT */]} */`
                        ), undefined, undefined, true);
            }
            else {
                // Normal element v-for. Directly use the child's codegenNode
                // but mark it as a block.
                childBlock = children[0]
                    .codegenNode;
                if (isTemplate && keyProperty) {
                    injectProp(childBlock, keyProperty, context);
                }
                if (childBlock.isBlock !== !isStableFragment) {
                    if (childBlock.isBlock) {
                        // switch from block to vnode
                        removeHelper(OPEN_BLOCK);
                        removeHelper(CREATE_BLOCK);
                    }
                    else {
                        // switch from vnode to block
                        removeHelper(CREATE_VNODE);
                    }
                }
                childBlock.isBlock = !isStableFragment;
                if (childBlock.isBlock) {
                    helper(OPEN_BLOCK);
                    helper(CREATE_BLOCK);
                }
                else {
                    helper(CREATE_VNODE);
                }
            }
            renderExp.arguments.push(createFunctionExpression(createForLoopParams(forNode.parseResult), childBlock, true /* force newline */));
        };
    });
});
// target-agnostic transform used for both Client and SSR
function processFor(node, dir, context, processCodegen) {
    if (!dir.exp) {
        context.onError(createCompilerError(30 /* X_V_FOR_NO_EXPRESSION */, dir.loc));
        return;
    }
    const parseResult = parseForExpression(
    // can only be simple expression because vFor transform is applied
    // before expression transform.
    dir.exp, context);
    if (!parseResult) {
        context.onError(createCompilerError(31 /* X_V_FOR_MALFORMED_EXPRESSION */, dir.loc));
        return;
    }
    const { addIdentifiers, removeIdentifiers, scopes } = context;
    const { source, value, key, index } = parseResult;
    const forNode = {
        type: 11 /* FOR */,
        loc: dir.loc,
        source,
        valueAlias: value,
        keyAlias: key,
        objectIndexAlias: index,
        parseResult,
        children: isTemplateNode(node) ? node.children : [node]
    };
    context.replaceNode(forNode);
    // bookkeeping
    scopes.vFor++;
    if (context.prefixIdentifiers) {
        // scope management
        // inject identifiers to context
        value && addIdentifiers(value);
        key && addIdentifiers(key);
        index && addIdentifiers(index);
    }
    const onExit = processCodegen && processCodegen(forNode);
    return () => {
        scopes.vFor--;
        if (context.prefixIdentifiers) {
            value && removeIdentifiers(value);
            key && removeIdentifiers(key);
            index && removeIdentifiers(index);
        }
        if (onExit)
            onExit();
    };
}
const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/;
// This regex doesn't cover the case if key or index aliases have destructuring,
// but those do not make sense in the first place, so this works in practice.
const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/;
const stripParensRE = /^\(|\)$/g;
function parseForExpression(input, context) {
    const loc = input.loc;
    const exp = input.content;
    const inMatch = exp.match(forAliasRE);
    if (!inMatch)
        return;
    const [, LHS, RHS] = inMatch;
    const result = {
        source: createAliasExpression(loc, RHS.trim(), exp.indexOf(RHS, LHS.length)),
        value: undefined,
        key: undefined,
        index: undefined
    };
    if (context.prefixIdentifiers) {
        result.source = processExpression(result.source, context);
    }
    let valueContent = LHS.trim()
        .replace(stripParensRE, '')
        .trim();
    const trimmedOffset = LHS.indexOf(valueContent);
    const iteratorMatch = valueContent.match(forIteratorRE);
    if (iteratorMatch) {
        valueContent = valueContent.replace(forIteratorRE, '').trim();
        const keyContent = iteratorMatch[1].trim();
        let keyOffset;
        if (keyContent) {
            keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length);
            result.key = createAliasExpression(loc, keyContent, keyOffset);
            if (context.prefixIdentifiers) {
                result.key = processExpression(result.key, context, true);
            }
        }
        if (iteratorMatch[2]) {
            const indexContent = iteratorMatch[2].trim();
            if (indexContent) {
                result.index = createAliasExpression(loc, indexContent, exp.indexOf(indexContent, result.key
                    ? keyOffset + keyContent.length
                    : trimmedOffset + valueContent.length));
                if (context.prefixIdentifiers) {
                    result.index = processExpression(result.index, context, true);
                }
            }
        }
    }
    if (valueContent) {
        result.value = createAliasExpression(loc, valueContent, trimmedOffset);
        if (context.prefixIdentifiers) {
            result.value = processExpression(result.value, context, true);
        }
    }
    return result;
}
function createAliasExpression(range, content, offset) {
    return createSimpleExpression(content, false, getInnerRange(range, offset, content.length));
}
function createForLoopParams({ value, key, index }) {
    const params = [];
    if (value) {
        params.push(value);
    }
    if (key) {
        if (!value) {
            params.push(createSimpleExpression(`_`, false));
        }
        params.push(key);
    }
    if (index) {
        if (!key) {
            if (!value) {
                params.push(createSimpleExpression(`_`, false));
            }
            params.push(createSimpleExpression(`__`, false));
        }
        params.push(index);
    }
    return params;
}

const defaultFallback = createSimpleExpression(`undefined`, false);
// A NodeTransform that:
// 1. Tracks scope identifiers for scoped slots so that they don't get prefixed
//    by transformExpression. This is only applied in non-browser builds with
//    { prefixIdentifiers: true }.
// 2. Track v-slot depths so that we know a slot is inside another slot.
//    Note the exit callback is executed before buildSlots() on the same node,
//    so only nested slots see positive numbers.
const trackSlotScopes = (node, context) => {
    if (node.type === 1 /* ELEMENT */ &&
        (node.tagType === 1 /* COMPONENT */ ||
            node.tagType === 3 /* TEMPLATE */)) {
        // We are only checking non-empty v-slot here
        // since we only care about slots that introduce scope variables.
        const vSlot = findDir(node, 'slot');
        if (vSlot) {
            const slotProps = vSlot.exp;
            if (context.prefixIdentifiers) {
                slotProps && context.addIdentifiers(slotProps);
            }
            context.scopes.vSlot++;
            return () => {
                if (context.prefixIdentifiers) {
                    slotProps && context.removeIdentifiers(slotProps);
                }
                context.scopes.vSlot--;
            };
        }
    }
};
// A NodeTransform that tracks scope identifiers for scoped slots with v-for.
// This transform is only applied in non-browser builds with { prefixIdentifiers: true }
const trackVForSlotScopes = (node, context) => {
    let vFor;
    if (isTemplateNode(node) &&
        node.props.some(isVSlot) &&
        (vFor = findDir(node, 'for'))) {
        const result = (vFor.parseResult = parseForExpression(vFor.exp, context));
        if (result) {
            const { value, key, index } = result;
            const { addIdentifiers, removeIdentifiers } = context;
            value && addIdentifiers(value);
            key && addIdentifiers(key);
            index && addIdentifiers(index);
            return () => {
                value && removeIdentifiers(value);
                key && removeIdentifiers(key);
                index && removeIdentifiers(index);
            };
        }
    }
};
const buildClientSlotFn = (props, children, loc) => createFunctionExpression(props, children, false /* newline */, true /* isSlot */, children.length ? children[0].loc : loc);
// Instead of being a DirectiveTransform, v-slot processing is called during
// transformElement to build the slots object for a component.
function buildSlots(node, context, buildSlotFn = buildClientSlotFn) {
    context.helper(WITH_CTX);
    const { children, loc } = node;
    const slotsProperties = [];
    const dynamicSlots = [];
    const buildDefaultSlotProperty = (props, children) => createObjectProperty(`default`, buildSlotFn(props, children, loc));
    // If the slot is inside a v-for or another v-slot, force it to be dynamic
    // since it likely uses a scope variable.
    let hasDynamicSlots = context.scopes.vSlot > 0 || context.scopes.vFor > 0;
    // with `prefixIdentifiers: true`, this can be further optimized to make
    // it dynamic only when the slot actually uses the scope variables.
    if (!context.ssr && context.prefixIdentifiers) {
        hasDynamicSlots = hasScopeRef(node, context.identifiers);
    }
    // 1. Check for slot with slotProps on component itself.
    //    <Comp v-slot="{ prop }"/>
    const onComponentSlot = findDir(node, 'slot', true);
    if (onComponentSlot) {
        const { arg, exp } = onComponentSlot;
        if (arg && !isStaticExp(arg)) {
            hasDynamicSlots = true;
        }
        slotsProperties.push(createObjectProperty(arg || createSimpleExpression('default', true), buildSlotFn(exp, children, loc)));
    }
    // 2. Iterate through children and check for template slots
    //    <template v-slot:foo="{ prop }">
    let hasTemplateSlots = false;
    let hasNamedDefaultSlot = false;
    const implicitDefaultChildren = [];
    const seenSlotNames = new Set();
    for (let i = 0; i < children.length; i++) {
        const slotElement = children[i];
        let slotDir;
        if (!isTemplateNode(slotElement) ||
            !(slotDir = findDir(slotElement, 'slot', true))) {
            // not a <template v-slot>, skip.
            if (slotElement.type !== 3 /* COMMENT */) {
                implicitDefaultChildren.push(slotElement);
            }
            continue;
        }
        if (onComponentSlot) {
            // already has on-component slot - this is incorrect usage.
            context.onError(createCompilerError(36 /* X_V_SLOT_MIXED_SLOT_USAGE */, slotDir.loc));
            break;
        }
        hasTemplateSlots = true;
        const { children: slotChildren, loc: slotLoc } = slotElement;
        const { arg: slotName = createSimpleExpression(`default`, true), exp: slotProps, loc: dirLoc } = slotDir;
        // check if name is dynamic.
        let staticSlotName;
        if (isStaticExp(slotName)) {
            staticSlotName = slotName ? slotName.content : `default`;
        }
        else {
            hasDynamicSlots = true;
        }
        const slotFunction = buildSlotFn(slotProps, slotChildren, slotLoc);
        // check if this slot is conditional (v-if/v-for)
        let vIf;
        let vElse;
        let vFor;
        if ((vIf = findDir(slotElement, 'if'))) {
            hasDynamicSlots = true;
            dynamicSlots.push(createConditionalExpression(vIf.exp, buildDynamicSlot(slotName, slotFunction), defaultFallback));
        }
        else if ((vElse = findDir(slotElement, /^else(-if)?$/, true /* allowEmpty */))) {
            // find adjacent v-if
            let j = i;
            let prev;
            while (j--) {
                prev = children[j];
                if (prev.type !== 3 /* COMMENT */) {
                    break;
                }
            }
            if (prev && isTemplateNode(prev) && findDir(prev, 'if')) {
                // remove node
                children.splice(i, 1);
                i--;
                // attach this slot to previous conditional
                let conditional = dynamicSlots[dynamicSlots.length - 1];
                while (conditional.alternate.type === 19 /* JS_CONDITIONAL_EXPRESSION */) {
                    conditional = conditional.alternate;
                }
                conditional.alternate = vElse.exp
                    ? createConditionalExpression(vElse.exp, buildDynamicSlot(slotName, slotFunction), defaultFallback)
                    : buildDynamicSlot(slotName, slotFunction);
            }
            else {
                context.onError(createCompilerError(29 /* X_V_ELSE_NO_ADJACENT_IF */, vElse.loc));
            }
        }
        else if ((vFor = findDir(slotElement, 'for'))) {
            hasDynamicSlots = true;
            const parseResult = vFor.parseResult ||
                parseForExpression(vFor.exp, context);
            if (parseResult) {
                // Render the dynamic slots as an array and add it to the createSlot()
                // args. The runtime knows how to handle it appropriately.
                dynamicSlots.push(createCallExpression(context.helper(RENDER_LIST), [
                    parseResult.source,
                    createFunctionExpression(createForLoopParams(parseResult), buildDynamicSlot(slotName, slotFunction), true /* force newline */)
                ]));
            }
            else {
                context.onError(createCompilerError(31 /* X_V_FOR_MALFORMED_EXPRESSION */, vFor.loc));
            }
        }
        else {
            // check duplicate static names
            if (staticSlotName) {
                if (seenSlotNames.has(staticSlotName)) {
                    context.onError(createCompilerError(37 /* X_V_SLOT_DUPLICATE_SLOT_NAMES */, dirLoc));
                    continue;
                }
                seenSlotNames.add(staticSlotName);
                if (staticSlotName === 'default') {
                    hasNamedDefaultSlot = true;
                }
            }
            slotsProperties.push(createObjectProperty(slotName, slotFunction));
        }
    }
    if (!onComponentSlot) {
        if (!hasTemplateSlots) {
            // implicit default slot (on component)
            slotsProperties.push(buildDefaultSlotProperty(undefined, children));
        }
        else if (implicitDefaultChildren.length) {
            // implicit default slot (mixed with named slots)
            if (hasNamedDefaultSlot) {
                context.onError(createCompilerError(38 /* X_V_SLOT_EXTRANEOUS_DEFAULT_SLOT_CHILDREN */, implicitDefaultChildren[0].loc));
            }
            else {
                slotsProperties.push(buildDefaultSlotProperty(undefined, implicitDefaultChildren));
            }
        }
    }
    const slotFlag = hasDynamicSlots
        ? 2 /* DYNAMIC */
        : hasForwardedSlots(node.children)
            ? 3 /* FORWARDED */
            : 1 /* STABLE */;
    let slots = createObjectExpression(slotsProperties.concat(createObjectProperty(`_`, 
    // 2 = compiled but dynamic = can skip normalization, but must run diff
    // 1 = compiled and static = can skip normalization AND diff as optimized
    createSimpleExpression(slotFlag + (` /* ${slotFlagsText[slotFlag]} */` ), false))), loc);
    if (dynamicSlots.length) {
        slots = createCallExpression(context.helper(CREATE_SLOTS), [
            slots,
            createArrayExpression(dynamicSlots)
        ]);
    }
    return {
        slots,
        hasDynamicSlots
    };
}
function buildDynamicSlot(name, fn) {
    return createObjectExpression([
        createObjectProperty(`name`, name),
        createObjectProperty(`fn`, fn)
    ]);
}
function hasForwardedSlots(children) {
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        switch (child.type) {
            case 1 /* ELEMENT */:
                if (child.tagType === 2 /* SLOT */ ||
                    (child.tagType === 0 /* ELEMENT */ &&
                        hasForwardedSlots(child.children))) {
                    return true;
                }
                break;
            case 9 /* IF */:
                if (hasForwardedSlots(child.branches))
                    return true;
                break;
            case 10 /* IF_BRANCH */:
            case 11 /* FOR */:
                if (hasForwardedSlots(child.children))
                    return true;
                break;
        }
    }
    return false;
}

// some directive transforms (e.g. v-model) may return a symbol for runtime
// import, which should be used instead of a resolveDirective call.
const directiveImportMap = new WeakMap();
// generate a JavaScript AST for this element's codegen
const transformElement = (node, context) => {
    // perform the work on exit, after all child expressions have been
    // processed and merged.
    return function postTransformElement() {
        node = context.currentNode;
        if (!(node.type === 1 /* ELEMENT */ &&
            (node.tagType === 0 /* ELEMENT */ ||
                node.tagType === 1 /* COMPONENT */))) {
            return;
        }
        const { tag, props } = node;
        const isComponent = node.tagType === 1 /* COMPONENT */;
        // The goal of the transform is to create a codegenNode implementing the
        // VNodeCall interface.
        const vnodeTag = isComponent
            ? resolveComponentType(node, context)
            : `"${tag}"`;
        const isDynamicComponent = isObject(vnodeTag) && vnodeTag.callee === RESOLVE_DYNAMIC_COMPONENT;
        let vnodeProps;
        let vnodeChildren;
        let vnodePatchFlag;
        let patchFlag = 0;
        let vnodeDynamicProps;
        let dynamicPropNames;
        let vnodeDirectives;
        let shouldUseBlock = 
        // dynamic component may resolve to plain elements
        isDynamicComponent ||
            vnodeTag === TELEPORT ||
            vnodeTag === SUSPENSE ||
            (!isComponent &&
                // <svg> and <foreignObject> must be forced into blocks so that block
                // updates inside get proper isSVG flag at runtime. (#639, #643)
                // This is technically web-specific, but splitting the logic out of core
                // leads to too much unnecessary complexity.
                (tag === 'svg' ||
                    tag === 'foreignObject' ||
                    // #938: elements with dynamic keys should be forced into blocks
                    findProp(node, 'key', true)));
        // props
        if (props.length > 0) {
            const propsBuildResult = buildProps(node, context);
            vnodeProps = propsBuildResult.props;
            patchFlag = propsBuildResult.patchFlag;
            dynamicPropNames = propsBuildResult.dynamicPropNames;
            const directives = propsBuildResult.directives;
            vnodeDirectives =
                directives && directives.length
                    ? createArrayExpression(directives.map(dir => buildDirectiveArgs(dir, context)))
                    : undefined;
        }
        // children
        if (node.children.length > 0) {
            if (vnodeTag === KEEP_ALIVE) {
                // Although a built-in component, we compile KeepAlive with raw children
                // instead of slot functions so that it can be used inside Transition
                // or other Transition-wrapping HOCs.
                // To ensure correct updates with block optimizations, we need to:
                // 1. Force keep-alive into a block. This avoids its children being
                //    collected by a parent block.
                shouldUseBlock = true;
                // 2. Force keep-alive to always be updated, since it uses raw children.
                patchFlag |= 1024 /* DYNAMIC_SLOTS */;
                if (node.children.length > 1) {
                    context.onError(createCompilerError(44 /* X_KEEP_ALIVE_INVALID_CHILDREN */, {
                        start: node.children[0].loc.start,
                        end: node.children[node.children.length - 1].loc.end,
                        source: ''
                    }));
                }
            }
            const shouldBuildAsSlots = isComponent &&
                // Teleport is not a real component and has dedicated runtime handling
                vnodeTag !== TELEPORT &&
                // explained above.
                vnodeTag !== KEEP_ALIVE;
            if (shouldBuildAsSlots) {
                const { slots, hasDynamicSlots } = buildSlots(node, context);
                vnodeChildren = slots;
                if (hasDynamicSlots) {
                    patchFlag |= 1024 /* DYNAMIC_SLOTS */;
                }
            }
            else if (node.children.length === 1 && vnodeTag !== TELEPORT) {
                const child = node.children[0];
                const type = child.type;
                // check for dynamic text children
                const hasDynamicTextChild = type === 5 /* INTERPOLATION */ ||
                    type === 8 /* COMPOUND_EXPRESSION */;
                if (hasDynamicTextChild &&
                    getConstantType(child, context) === 0 /* NOT_CONSTANT */) {
                    patchFlag |= 1 /* TEXT */;
                }
                // pass directly if the only child is a text node
                // (plain / interpolation / expression)
                if (hasDynamicTextChild || type === 2 /* TEXT */) {
                    vnodeChildren = child;
                }
                else {
                    vnodeChildren = node.children;
                }
            }
            else {
                vnodeChildren = node.children;
            }
        }
        // patchFlag & dynamicPropNames
        if (patchFlag !== 0) {
            {
                if (patchFlag < 0) {
                    // special flags (negative and mutually exclusive)
                    vnodePatchFlag = patchFlag + ` /* ${PatchFlagNames[patchFlag]} */`;
                }
                else {
                    // bitwise flags
                    const flagNames = Object.keys(PatchFlagNames)
                        .map(Number)
                        .filter(n => n > 0 && patchFlag & n)
                        .map(n => PatchFlagNames[n])
                        .join(`, `);
                    vnodePatchFlag = patchFlag + ` /* ${flagNames} */`;
                }
            }
            if (dynamicPropNames && dynamicPropNames.length) {
                vnodeDynamicProps = stringifyDynamicPropNames(dynamicPropNames);
            }
        }
        node.codegenNode = createVNodeCall(context, vnodeTag, vnodeProps, vnodeChildren, vnodePatchFlag, vnodeDynamicProps, vnodeDirectives, !!shouldUseBlock, false /* disableTracking */, node.loc);
    };
};
function resolveComponentType(node, context, ssr = false) {
    const { tag } = node;
    // 1. dynamic component
    const isProp = isComponentTag(tag)
        ? findProp(node, 'is')
        : findDir(node, 'is');
    if (isProp) {
        const exp = isProp.type === 6 /* ATTRIBUTE */
            ? isProp.value && createSimpleExpression(isProp.value.content, true)
            : isProp.exp;
        if (exp) {
            return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
                exp
            ]);
        }
    }
    // 2. built-in components (Teleport, Transition, KeepAlive, Suspense...)
    const builtIn = isCoreComponent(tag) || context.isBuiltInComponent(tag);
    if (builtIn) {
        // built-ins are simply fallthroughs / have special handling during ssr
        // so we don't need to import their runtime equivalents
        if (!ssr)
            context.helper(builtIn);
        return builtIn;
    }
    // 3. user component (from setup bindings)
    // this is skipped in browser build since browser builds do not perform
    // binding analysis.
    {
        const fromSetup = resolveSetupReference(tag, context);
        if (fromSetup) {
            return fromSetup;
        }
    }
    // 4. Self referencing component (inferred from filename)
    if (context.selfName &&
        capitalize(camelize(tag)) === context.selfName) {
        context.helper(RESOLVE_COMPONENT);
        // codegen.ts has special check for __self postfix when generating
        // component imports, which will pass additional `maybeSelfReference` flag
        // to `resolveComponent`.
        context.components.add(tag + `__self`);
        return toValidAssetId(tag, `component`);
    }
    // 5. user component (resolve)
    context.helper(RESOLVE_COMPONENT);
    context.components.add(tag);
    return toValidAssetId(tag, `component`);
}
function resolveSetupReference(name, context) {
    const bindings = context.bindingMetadata;
    if (!bindings || bindings.__isScriptSetup === false) {
        return;
    }
    const camelName = camelize(name);
    const PascalName = capitalize(camelName);
    const checkType = (type) => {
        if (bindings[name] === type) {
            return name;
        }
        if (bindings[camelName] === type) {
            return camelName;
        }
        if (bindings[PascalName] === type) {
            return PascalName;
        }
    };
    const fromConst = checkType("setup-const" /* SETUP_CONST */);
    if (fromConst) {
        return context.inline
            ? // in inline mode, const setup bindings (e.g. imports) can be used as-is
                fromConst
            : `$setup[${JSON.stringify(fromConst)}]`;
    }
    const fromMaybeRef = checkType("setup-let" /* SETUP_LET */) ||
        checkType("setup-ref" /* SETUP_REF */) ||
        checkType("setup-maybe-ref" /* SETUP_MAYBE_REF */);
    if (fromMaybeRef) {
        return context.inline
            ? // setup scope bindings that may be refs need to be unrefed
                `${context.helperString(UNREF)}(${fromMaybeRef})`
            : `$setup[${JSON.stringify(fromMaybeRef)}]`;
    }
}
function buildProps(node, context, props = node.props, ssr = false) {
    const { tag, loc: elementLoc } = node;
    const isComponent = node.tagType === 1 /* COMPONENT */;
    let properties = [];
    const mergeArgs = [];
    const runtimeDirectives = [];
    // patchFlag analysis
    let patchFlag = 0;
    let hasRef = false;
    let hasClassBinding = false;
    let hasStyleBinding = false;
    let hasHydrationEventBinding = false;
    let hasDynamicKeys = false;
    let hasVnodeHook = false;
    const dynamicPropNames = [];
    const analyzePatchFlag = ({ key, value }) => {
        if (isStaticExp(key)) {
            const name = key.content;
            const isEventHandler = isOn(name);
            if (!isComponent &&
                isEventHandler &&
                // omit the flag for click handlers because hydration gives click
                // dedicated fast path.
                name.toLowerCase() !== 'onclick' &&
                // omit v-model handlers
                name !== 'onUpdate:modelValue' &&
                // omit onVnodeXXX hooks
                !isReservedProp(name)) {
                hasHydrationEventBinding = true;
            }
            if (isEventHandler && isReservedProp(name)) {
                hasVnodeHook = true;
            }
            if (value.type === 20 /* JS_CACHE_EXPRESSION */ ||
                ((value.type === 4 /* SIMPLE_EXPRESSION */ ||
                    value.type === 8 /* COMPOUND_EXPRESSION */) &&
                    getConstantType(value, context) > 0)) {
                // skip if the prop is a cached handler or has constant value
                return;
            }
            if (name === 'ref') {
                hasRef = true;
            }
            else if (name === 'class' && !isComponent) {
                hasClassBinding = true;
            }
            else if (name === 'style' && !isComponent) {
                hasStyleBinding = true;
            }
            else if (name !== 'key' && !dynamicPropNames.includes(name)) {
                dynamicPropNames.push(name);
            }
        }
        else {
            hasDynamicKeys = true;
        }
    };
    for (let i = 0; i < props.length; i++) {
        // static attribute
        const prop = props[i];
        if (prop.type === 6 /* ATTRIBUTE */) {
            const { loc, name, value } = prop;
            let isStatic = true;
            if (name === 'ref') {
                hasRef = true;
                // in inline mode there is no setupState object, so we can't use string
                // keys to set the ref. Instead, we need to transform it to pass the
                // acrtual ref instead.
                if (context.inline) {
                    isStatic = false;
                }
            }
            // skip :is on <component>
            if (name === 'is' && isComponentTag(tag)) {
                continue;
            }
            properties.push(createObjectProperty(createSimpleExpression(name, true, getInnerRange(loc, 0, name.length)), createSimpleExpression(value ? value.content : '', isStatic, value ? value.loc : loc)));
        }
        else {
            // directives
            const { name, arg, exp, loc } = prop;
            const isBind = name === 'bind';
            const isOn = name === 'on';
            // skip v-slot - it is handled by its dedicated transform.
            if (name === 'slot') {
                if (!isComponent) {
                    context.onError(createCompilerError(39 /* X_V_SLOT_MISPLACED */, loc));
                }
                continue;
            }
            // skip v-once - it is handled by its dedicated transform.
            if (name === 'once') {
                continue;
            }
            // skip v-is and :is on <component>
            if (name === 'is' ||
                (isBind && isComponentTag(tag) && isBindKey(arg, 'is'))) {
                continue;
            }
            // skip v-on in SSR compilation
            if (isOn && ssr) {
                continue;
            }
            // special case for v-bind and v-on with no argument
            if (!arg && (isBind || isOn)) {
                hasDynamicKeys = true;
                if (exp) {
                    if (properties.length) {
                        mergeArgs.push(createObjectExpression(dedupeProperties(properties), elementLoc));
                        properties = [];
                    }
                    if (isBind) {
                        mergeArgs.push(exp);
                    }
                    else {
                        // v-on="obj" -> toHandlers(obj)
                        mergeArgs.push({
                            type: 14 /* JS_CALL_EXPRESSION */,
                            loc,
                            callee: context.helper(TO_HANDLERS),
                            arguments: [exp]
                        });
                    }
                }
                else {
                    context.onError(createCompilerError(isBind
                        ? 33 /* X_V_BIND_NO_EXPRESSION */
                        : 34 /* X_V_ON_NO_EXPRESSION */, loc));
                }
                continue;
            }
            const directiveTransform = context.directiveTransforms[name];
            if (directiveTransform) {
                // has built-in directive transform.
                const { props, needRuntime } = directiveTransform(prop, node, context);
                !ssr && props.forEach(analyzePatchFlag);
                properties.push(...props);
                if (needRuntime) {
                    runtimeDirectives.push(prop);
                    if (isSymbol(needRuntime)) {
                        directiveImportMap.set(prop, needRuntime);
                    }
                }
            }
            else {
                // no built-in transform, this is a user custom directive.
                runtimeDirectives.push(prop);
            }
        }
    }
    let propsExpression = undefined;
    // has v-bind="object" or v-on="object", wrap with mergeProps
    if (mergeArgs.length) {
        if (properties.length) {
            mergeArgs.push(createObjectExpression(dedupeProperties(properties), elementLoc));
        }
        if (mergeArgs.length > 1) {
            propsExpression = createCallExpression(context.helper(MERGE_PROPS), mergeArgs, elementLoc);
        }
        else {
            // single v-bind with nothing else - no need for a mergeProps call
            propsExpression = mergeArgs[0];
        }
    }
    else if (properties.length) {
        propsExpression = createObjectExpression(dedupeProperties(properties), elementLoc);
    }
    // patchFlag analysis
    if (hasDynamicKeys) {
        patchFlag |= 16 /* FULL_PROPS */;
    }
    else {
        if (hasClassBinding) {
            patchFlag |= 2 /* CLASS */;
        }
        if (hasStyleBinding) {
            patchFlag |= 4 /* STYLE */;
        }
        if (dynamicPropNames.length) {
            patchFlag |= 8 /* PROPS */;
        }
        if (hasHydrationEventBinding) {
            patchFlag |= 32 /* HYDRATE_EVENTS */;
        }
    }
    if ((patchFlag === 0 || patchFlag === 32 /* HYDRATE_EVENTS */) &&
        (hasRef || hasVnodeHook || runtimeDirectives.length > 0)) {
        patchFlag |= 512 /* NEED_PATCH */;
    }
    return {
        props: propsExpression,
        directives: runtimeDirectives,
        patchFlag,
        dynamicPropNames
    };
}
// Dedupe props in an object literal.
// Literal duplicated attributes would have been warned during the parse phase,
// however, it's possible to encounter duplicated `onXXX` handlers with different
// modifiers. We also need to merge static and dynamic class / style attributes.
// - onXXX handlers / style: merge into array
// - class: merge into single expression with concatenation
function dedupeProperties(properties) {
    const knownProps = new Map();
    const deduped = [];
    for (let i = 0; i < properties.length; i++) {
        const prop = properties[i];
        // dynamic keys are always allowed
        if (prop.key.type === 8 /* COMPOUND_EXPRESSION */ || !prop.key.isStatic) {
            deduped.push(prop);
            continue;
        }
        const name = prop.key.content;
        const existing = knownProps.get(name);
        if (existing) {
            if (name === 'style' || name === 'class' || name.startsWith('on')) {
                mergeAsArray(existing, prop);
            }
            // unexpected duplicate, should have emitted error during parse
        }
        else {
            knownProps.set(name, prop);
            deduped.push(prop);
        }
    }
    return deduped;
}
function mergeAsArray(existing, incoming) {
    if (existing.value.type === 17 /* JS_ARRAY_EXPRESSION */) {
        existing.value.elements.push(incoming.value);
    }
    else {
        existing.value = createArrayExpression([existing.value, incoming.value], existing.loc);
    }
}
function buildDirectiveArgs(dir, context) {
    const dirArgs = [];
    const runtime = directiveImportMap.get(dir);
    if (runtime) {
        // built-in directive with runtime
        dirArgs.push(context.helperString(runtime));
    }
    else {
        // user directive.
        // see if we have directives exposed via <script setup>
        const fromSetup = resolveSetupReference(dir.name, context);
        if (fromSetup) {
            dirArgs.push(fromSetup);
        }
        else {
            // inject statement for resolving directive
            context.helper(RESOLVE_DIRECTIVE);
            context.directives.add(dir.name);
            dirArgs.push(toValidAssetId(dir.name, `directive`));
        }
    }
    const { loc } = dir;
    if (dir.exp)
        dirArgs.push(dir.exp);
    if (dir.arg) {
        if (!dir.exp) {
            dirArgs.push(`void 0`);
        }
        dirArgs.push(dir.arg);
    }
    if (Object.keys(dir.modifiers).length) {
        if (!dir.arg) {
            if (!dir.exp) {
                dirArgs.push(`void 0`);
            }
            dirArgs.push(`void 0`);
        }
        const trueExpression = createSimpleExpression(`true`, false, loc);
        dirArgs.push(createObjectExpression(dir.modifiers.map(modifier => createObjectProperty(modifier, trueExpression)), loc));
    }
    return createArrayExpression(dirArgs, dir.loc);
}
function stringifyDynamicPropNames(props) {
    let propsNamesString = `[`;
    for (let i = 0, l = props.length; i < l; i++) {
        propsNamesString += JSON.stringify(props[i]);
        if (i < l - 1)
            propsNamesString += ', ';
    }
    return propsNamesString + `]`;
}
function isComponentTag(tag) {
    return tag[0].toLowerCase() + tag.slice(1) === 'component';
}

const transformSlotOutlet = (node, context) => {
    if (isSlotOutlet(node)) {
        const { children, loc } = node;
        const { slotName, slotProps } = processSlotOutlet(node, context);
        const slotArgs = [
            context.prefixIdentifiers ? `_ctx.$slots` : `$slots`,
            slotName
        ];
        if (slotProps) {
            slotArgs.push(slotProps);
        }
        if (children.length) {
            if (!slotProps) {
                slotArgs.push(`{}`);
            }
            slotArgs.push(createFunctionExpression([], children, false, false, loc));
        }
        if (context.scopeId && !context.slotted) {
            if (!slotProps) {
                slotArgs.push(`{}`);
            }
            if (!children.length) {
                slotArgs.push(`undefined`);
            }
            slotArgs.push(`true`);
        }
        node.codegenNode = createCallExpression(context.helper(RENDER_SLOT), slotArgs, loc);
    }
};
function processSlotOutlet(node, context) {
    let slotName = `"default"`;
    let slotProps = undefined;
    const nonNameProps = [];
    for (let i = 0; i < node.props.length; i++) {
        const p = node.props[i];
        if (p.type === 6 /* ATTRIBUTE */) {
            if (p.value) {
                if (p.name === 'name') {
                    slotName = JSON.stringify(p.value.content);
                }
                else {
                    p.name = camelize(p.name);
                    nonNameProps.push(p);
                }
            }
        }
        else {
            if (p.name === 'bind' && isBindKey(p.arg, 'name')) {
                if (p.exp)
                    slotName = p.exp;
            }
            else {
                if (p.name === 'bind' && p.arg && isStaticExp(p.arg)) {
                    p.arg.content = camelize(p.arg.content);
                }
                nonNameProps.push(p);
            }
        }
    }
    if (nonNameProps.length > 0) {
        const { props, directives } = buildProps(node, context, nonNameProps);
        slotProps = props;
        if (directives.length) {
            context.onError(createCompilerError(35 /* X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET */, directives[0].loc));
        }
    }
    return {
        slotName,
        slotProps
    };
}

const fnExpRE = /^\s*([\w$_]+|\([^)]*?\))\s*=>|^\s*function(?:\s+[\w$]+)?\s*\(/;
const transformOn = (dir, node, context, augmentor) => {
    const { loc, modifiers, arg } = dir;
    if (!dir.exp && !modifiers.length) {
        context.onError(createCompilerError(34 /* X_V_ON_NO_EXPRESSION */, loc));
    }
    let eventName;
    if (arg.type === 4 /* SIMPLE_EXPRESSION */) {
        if (arg.isStatic) {
            const rawName = arg.content;
            // for all event listeners, auto convert it to camelCase. See issue #2249
            eventName = createSimpleExpression(toHandlerKey(camelize(rawName)), true, arg.loc);
        }
        else {
            // #2388
            eventName = createCompoundExpression([
                `${context.helperString(TO_HANDLER_KEY)}(`,
                arg,
                `)`
            ]);
        }
    }
    else {
        // already a compound expression.
        eventName = arg;
        eventName.children.unshift(`${context.helperString(TO_HANDLER_KEY)}(`);
        eventName.children.push(`)`);
    }
    // handler processing
    let exp = dir.exp;
    if (exp && !exp.content.trim()) {
        exp = undefined;
    }
    let shouldCache = context.cacheHandlers && !exp;
    if (exp) {
        const isMemberExp = isMemberExpression(exp.content);
        const isInlineStatement = !(isMemberExp || fnExpRE.test(exp.content));
        const hasMultipleStatements = exp.content.includes(`;`);
        // process the expression since it's been skipped
        if (context.prefixIdentifiers) {
            isInlineStatement && context.addIdentifiers(`$event`);
            exp = dir.exp = processExpression(exp, context, false, hasMultipleStatements);
            isInlineStatement && context.removeIdentifiers(`$event`);
            // with scope analysis, the function is hoistable if it has no reference
            // to scope variables.
            shouldCache =
                context.cacheHandlers &&
                    // runtime constants don't need to be cached
                    // (this is analyzed by compileScript in SFC <script setup>)
                    !(exp.type === 4 /* SIMPLE_EXPRESSION */ && exp.constType > 0) &&
                    // #1541 bail if this is a member exp handler passed to a component -
                    // we need to use the original function to preserve arity,
                    // e.g. <transition> relies on checking cb.length to determine
                    // transition end handling. Inline function is ok since its arity
                    // is preserved even when cached.
                    !(isMemberExp && node.tagType === 1 /* COMPONENT */) &&
                    // bail if the function references closure variables (v-for, v-slot)
                    // it must be passed fresh to avoid stale values.
                    !hasScopeRef(exp, context.identifiers);
            // If the expression is optimizable and is a member expression pointing
            // to a function, turn it into invocation (and wrap in an arrow function
            // below) so that it always accesses the latest value when called - thus
            // avoiding the need to be patched.
            if (shouldCache && isMemberExp) {
                if (exp.type === 4 /* SIMPLE_EXPRESSION */) {
                    exp.content = `${exp.content} && ${exp.content}(...args)`;
                }
                else {
                    exp.children = [...exp.children, ` && `, ...exp.children, `(...args)`];
                }
            }
        }
        if (isInlineStatement || (shouldCache && isMemberExp)) {
            // wrap inline statement in a function expression
            exp = createCompoundExpression([
                `${isInlineStatement
                    ? context.isTS
                        ? `($event: any)`
                        : `$event`
                    : `${context.isTS ? `\n//@ts-ignore\n` : ``}(...args)`} => ${hasMultipleStatements ? `{` : `(`}`,
                exp,
                hasMultipleStatements ? `}` : `)`
            ]);
        }
    }
    let ret = {
        props: [
            createObjectProperty(eventName, exp || createSimpleExpression(`() => {}`, false, loc))
        ]
    };
    // apply extended compiler augmentor
    if (augmentor) {
        ret = augmentor(ret);
    }
    if (shouldCache) {
        // cache handlers so that it's always the same handler being passed down.
        // this avoids unnecessary re-renders when users use inline handlers on
        // components.
        ret.props[0].value = context.cache(ret.props[0].value);
    }
    return ret;
};

// v-bind without arg is handled directly in ./transformElements.ts due to it affecting
// codegen for the entire props object. This transform here is only for v-bind
// *with* args.
const transformBind = (dir, node, context) => {
    const { exp, modifiers, loc } = dir;
    const arg = dir.arg;
    if (arg.type !== 4 /* SIMPLE_EXPRESSION */) {
        arg.children.unshift(`(`);
        arg.children.push(`) || ""`);
    }
    else if (!arg.isStatic) {
        arg.content = `${arg.content} || ""`;
    }
    // .prop is no longer necessary due to new patch behavior
    // .sync is replaced by v-model:arg
    if (modifiers.includes('camel')) {
        if (arg.type === 4 /* SIMPLE_EXPRESSION */) {
            if (arg.isStatic) {
                arg.content = camelize(arg.content);
            }
            else {
                arg.content = `${context.helperString(CAMELIZE)}(${arg.content})`;
            }
        }
        else {
            arg.children.unshift(`${context.helperString(CAMELIZE)}(`);
            arg.children.push(`)`);
        }
    }
    if (!exp ||
        (exp.type === 4 /* SIMPLE_EXPRESSION */ && !exp.content.trim())) {
        context.onError(createCompilerError(33 /* X_V_BIND_NO_EXPRESSION */, loc));
        return {
            props: [createObjectProperty(arg, createSimpleExpression('', true, loc))]
        };
    }
    return {
        props: [createObjectProperty(arg, exp)]
    };
};

// Merge adjacent text nodes and expressions into a single expression
// e.g. <div>abc {{ d }} {{ e }}</div> should have a single expression node as child.
const transformText = (node, context) => {
    if (node.type === 0 /* ROOT */ ||
        node.type === 1 /* ELEMENT */ ||
        node.type === 11 /* FOR */ ||
        node.type === 10 /* IF_BRANCH */) {
        // perform the transform on node exit so that all expressions have already
        // been processed.
        return () => {
            const children = node.children;
            let currentContainer = undefined;
            let hasText = false;
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (isText(child)) {
                    hasText = true;
                    for (let j = i + 1; j < children.length; j++) {
                        const next = children[j];
                        if (isText(next)) {
                            if (!currentContainer) {
                                currentContainer = children[i] = {
                                    type: 8 /* COMPOUND_EXPRESSION */,
                                    loc: child.loc,
                                    children: [child]
                                };
                            }
                            // merge adjacent text node into current
                            currentContainer.children.push(` + `, next);
                            children.splice(j, 1);
                            j--;
                        }
                        else {
                            currentContainer = undefined;
                            break;
                        }
                    }
                }
            }
            if (!hasText ||
                // if this is a plain element with a single text child, leave it
                // as-is since the runtime has dedicated fast path for this by directly
                // setting textContent of the element.
                // for component root it's always normalized anyway.
                (children.length === 1 &&
                    (node.type === 0 /* ROOT */ ||
                        (node.type === 1 /* ELEMENT */ &&
                            node.tagType === 0 /* ELEMENT */)))) {
                return;
            }
            // pre-convert text nodes into createTextVNode(text) calls to avoid
            // runtime normalization.
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (isText(child) || child.type === 8 /* COMPOUND_EXPRESSION */) {
                    const callArgs = [];
                    // createTextVNode defaults to single whitespace, so if it is a
                    // single space the code could be an empty call to save bytes.
                    if (child.type !== 2 /* TEXT */ || child.content !== ' ') {
                        callArgs.push(child);
                    }
                    // mark dynamic text with flag so it gets patched inside a block
                    if (!context.ssr &&
                        getConstantType(child, context) === 0 /* NOT_CONSTANT */) {
                        callArgs.push(1 /* TEXT */ +
                            (` /* ${PatchFlagNames[1 /* TEXT */]} */` ));
                    }
                    children[i] = {
                        type: 12 /* TEXT_CALL */,
                        content: child,
                        loc: child.loc,
                        codegenNode: createCallExpression(context.helper(CREATE_TEXT), callArgs)
                    };
                }
            }
        };
    }
};

const seen = new WeakSet();
const transformOnce = (node, context) => {
    if (node.type === 1 /* ELEMENT */ && findDir(node, 'once', true)) {
        if (seen.has(node)) {
            return;
        }
        seen.add(node);
        context.helper(SET_BLOCK_TRACKING);
        return () => {
            const cur = context.currentNode;
            if (cur.codegenNode) {
                cur.codegenNode = context.cache(cur.codegenNode, true /* isVNode */);
            }
        };
    }
};

const transformModel = (dir, node, context) => {
    const { exp, arg } = dir;
    if (!exp) {
        context.onError(createCompilerError(40 /* X_V_MODEL_NO_EXPRESSION */, dir.loc));
        return createTransformProps();
    }
    const rawExp = exp.loc.source;
    const expString = exp.type === 4 /* SIMPLE_EXPRESSION */ ? exp.content : rawExp;
    // im SFC <script setup> inline mode, the exp may have been transformed into
    // _unref(exp)
    const bindingType = context.bindingMetadata[rawExp];
    const maybeRef = context.inline &&
        bindingType &&
        bindingType !== "setup-const" /* SETUP_CONST */;
    if (!isMemberExpression(expString) && !maybeRef) {
        context.onError(createCompilerError(41 /* X_V_MODEL_MALFORMED_EXPRESSION */, exp.loc));
        return createTransformProps();
    }
    if (context.prefixIdentifiers &&
        isSimpleIdentifier(expString) &&
        context.identifiers[expString]) {
        context.onError(createCompilerError(42 /* X_V_MODEL_ON_SCOPE_VARIABLE */, exp.loc));
        return createTransformProps();
    }
    const propName = arg ? arg : createSimpleExpression('modelValue', true);
    const eventName = arg
        ? isStaticExp(arg)
            ? `onUpdate:${arg.content}`
            : createCompoundExpression(['"onUpdate:" + ', arg])
        : `onUpdate:modelValue`;
    let assignmentExp;
    const eventArg = context.isTS ? `($event: any)` : `$event`;
    if (maybeRef) {
        if (bindingType === "setup-ref" /* SETUP_REF */) {
            // v-model used on known ref.
            assignmentExp = createCompoundExpression([
                `${eventArg} => (`,
                createSimpleExpression(rawExp, false, exp.loc),
                `.value = $event)`
            ]);
        }
        else {
            // v-model used on a potentially ref binding in <script setup> inline mode.
            // the assignment needs to check whether the binding is actually a ref.
            const altAssignment = bindingType === "setup-let" /* SETUP_LET */ ? `${rawExp} = $event` : `null`;
            assignmentExp = createCompoundExpression([
                `${eventArg} => (${context.helperString(IS_REF)}(${rawExp}) ? `,
                createSimpleExpression(rawExp, false, exp.loc),
                `.value = $event : ${altAssignment})`
            ]);
        }
    }
    else {
        assignmentExp = createCompoundExpression([
            `${eventArg} => (`,
            exp,
            ` = $event)`
        ]);
    }
    const props = [
        // modelValue: foo
        createObjectProperty(propName, dir.exp),
        // "onUpdate:modelValue": $event => (foo = $event)
        createObjectProperty(eventName, assignmentExp)
    ];
    // cache v-model handler if applicable (when it doesn't refer any scope vars)
    if (context.prefixIdentifiers &&
        context.cacheHandlers &&
        !hasScopeRef(exp, context.identifiers)) {
        props[1].value = context.cache(props[1].value);
    }
    // modelModifiers: { foo: true, "bar-baz": true }
    if (dir.modifiers.length && node.tagType === 1 /* COMPONENT */) {
        const modifiers = dir.modifiers
            .map(m => (isSimpleIdentifier(m) ? m : JSON.stringify(m)) + `: true`)
            .join(`, `);
        const modifiersKey = arg
            ? isStaticExp(arg)
                ? `${arg.content}Modifiers`
                : createCompoundExpression([arg, ' + "Modifiers"'])
            : `modelModifiers`;
        props.push(createObjectProperty(modifiersKey, createSimpleExpression(`{ ${modifiers} }`, false, dir.loc, 2 /* CAN_HOIST */)));
    }
    return createTransformProps(props);
};
function createTransformProps(props = []) {
    return { props };
}

function getBaseTransformPreset(prefixIdentifiers) {
    return [
        [
            transformOnce,
            transformIf,
            transformFor,
            ...(prefixIdentifiers
                ? [
                    // order is important
                    trackVForSlotScopes,
                    transformExpression
                ]
                : []),
            transformSlotOutlet,
            transformElement,
            trackSlotScopes,
            transformText
        ],
        {
            on: transformOn,
            bind: transformBind,
            model: transformModel
        }
    ];
}
// we name it `baseCompile` so that higher order compilers like
// @vue/compiler-dom can export `compile` while re-exporting everything else.
function baseCompile(template, options = {}) {
    const onError = options.onError || defaultOnError;
    const isModuleMode = options.mode === 'module';
    const prefixIdentifiers = (options.prefixIdentifiers === true || isModuleMode);
    if (!prefixIdentifiers && options.cacheHandlers) {
        onError(createCompilerError(47 /* X_CACHE_HANDLER_NOT_SUPPORTED */));
    }
    if (options.scopeId && !isModuleMode) {
        onError(createCompilerError(48 /* X_SCOPE_ID_NOT_SUPPORTED */));
    }
    const ast = isString(template) ? baseParse(template, options) : template;
    const [nodeTransforms, directiveTransforms] = getBaseTransformPreset(prefixIdentifiers);
    transform(ast, extend({}, options, {
        prefixIdentifiers,
        nodeTransforms: [
            ...nodeTransforms,
            ...(options.nodeTransforms || []) // user transforms
        ],
        directiveTransforms: extend({}, directiveTransforms, options.directiveTransforms || {} // user transforms
        )
    }));
    return generate(ast, extend({}, options, {
        prefixIdentifiers
    }));
}

const noopDirectiveTransform = () => ({ props: [] });

const V_MODEL_RADIO = Symbol(`vModelRadio` );
const V_MODEL_CHECKBOX = Symbol(`vModelCheckbox` );
const V_MODEL_TEXT = Symbol(`vModelText` );
const V_MODEL_SELECT = Symbol(`vModelSelect` );
const V_MODEL_DYNAMIC = Symbol(`vModelDynamic` );
const V_ON_WITH_MODIFIERS = Symbol(`vOnModifiersGuard` );
const V_ON_WITH_KEYS = Symbol(`vOnKeysGuard` );
const V_SHOW = Symbol(`vShow` );
const TRANSITION = Symbol(`Transition` );
const TRANSITION_GROUP = Symbol(`TransitionGroup` );
registerRuntimeHelpers({
    [V_MODEL_RADIO]: `vModelRadio`,
    [V_MODEL_CHECKBOX]: `vModelCheckbox`,
    [V_MODEL_TEXT]: `vModelText`,
    [V_MODEL_SELECT]: `vModelSelect`,
    [V_MODEL_DYNAMIC]: `vModelDynamic`,
    [V_ON_WITH_MODIFIERS]: `withModifiers`,
    [V_ON_WITH_KEYS]: `withKeys`,
    [V_SHOW]: `vShow`,
    [TRANSITION]: `Transition`,
    [TRANSITION_GROUP]: `TransitionGroup`
});

var namedCharacterReferences = {
	GT: ">",
	gt: ">",
	LT: "<",
	lt: "<",
	"ac;": "∾",
	"af;": "⁡",
	AMP: "&",
	amp: "&",
	"ap;": "≈",
	"DD;": "ⅅ",
	"dd;": "ⅆ",
	deg: "°",
	"ee;": "ⅇ",
	"eg;": "⪚",
	"el;": "⪙",
	ETH: "Ð",
	eth: "ð",
	"gE;": "≧",
	"ge;": "≥",
	"Gg;": "⋙",
	"gg;": "≫",
	"gl;": "≷",
	"GT;": ">",
	"Gt;": "≫",
	"gt;": ">",
	"ic;": "⁣",
	"ii;": "ⅈ",
	"Im;": "ℑ",
	"in;": "∈",
	"it;": "⁢",
	"lE;": "≦",
	"le;": "≤",
	"lg;": "≶",
	"Ll;": "⋘",
	"ll;": "≪",
	"LT;": "<",
	"Lt;": "≪",
	"lt;": "<",
	"mp;": "∓",
	"Mu;": "Μ",
	"mu;": "μ",
	"ne;": "≠",
	"ni;": "∋",
	not: "¬",
	"Nu;": "Ν",
	"nu;": "ν",
	"Or;": "⩔",
	"or;": "∨",
	"oS;": "Ⓢ",
	"Pi;": "Π",
	"pi;": "π",
	"pm;": "±",
	"Pr;": "⪻",
	"pr;": "≺",
	"Re;": "ℜ",
	REG: "®",
	reg: "®",
	"rx;": "℞",
	"Sc;": "⪼",
	"sc;": "≻",
	shy: "­",
	uml: "¨",
	"wp;": "℘",
	"wr;": "≀",
	"Xi;": "Ξ",
	"xi;": "ξ",
	yen: "¥",
	"acd;": "∿",
	"acE;": "∾̳",
	"Acy;": "А",
	"acy;": "а",
	"Afr;": "𝔄",
	"afr;": "𝔞",
	"AMP;": "&",
	"amp;": "&",
	"And;": "⩓",
	"and;": "∧",
	"ang;": "∠",
	"apE;": "⩰",
	"ape;": "≊",
	"ast;": "*",
	Auml: "Ä",
	auml: "ä",
	"Bcy;": "Б",
	"bcy;": "б",
	"Bfr;": "𝔅",
	"bfr;": "𝔟",
	"bne;": "=⃥",
	"bot;": "⊥",
	"Cap;": "⋒",
	"cap;": "∩",
	cent: "¢",
	"Cfr;": "ℭ",
	"cfr;": "𝔠",
	"Chi;": "Χ",
	"chi;": "χ",
	"cir;": "○",
	COPY: "©",
	copy: "©",
	"Cup;": "⋓",
	"cup;": "∪",
	"Dcy;": "Д",
	"dcy;": "д",
	"deg;": "°",
	"Del;": "∇",
	"Dfr;": "𝔇",
	"dfr;": "𝔡",
	"die;": "¨",
	"div;": "÷",
	"Dot;": "¨",
	"dot;": "˙",
	"Ecy;": "Э",
	"ecy;": "э",
	"Efr;": "𝔈",
	"efr;": "𝔢",
	"egs;": "⪖",
	"ell;": "ℓ",
	"els;": "⪕",
	"ENG;": "Ŋ",
	"eng;": "ŋ",
	"Eta;": "Η",
	"eta;": "η",
	"ETH;": "Ð",
	"eth;": "ð",
	Euml: "Ë",
	euml: "ë",
	"Fcy;": "Ф",
	"fcy;": "ф",
	"Ffr;": "𝔉",
	"ffr;": "𝔣",
	"gap;": "⪆",
	"Gcy;": "Г",
	"gcy;": "г",
	"gEl;": "⪌",
	"gel;": "⋛",
	"geq;": "≥",
	"ges;": "⩾",
	"Gfr;": "𝔊",
	"gfr;": "𝔤",
	"ggg;": "⋙",
	"gla;": "⪥",
	"glE;": "⪒",
	"glj;": "⪤",
	"gnE;": "≩",
	"gne;": "⪈",
	"Hat;": "^",
	"Hfr;": "ℌ",
	"hfr;": "𝔥",
	"Icy;": "И",
	"icy;": "и",
	"iff;": "⇔",
	"Ifr;": "ℑ",
	"ifr;": "𝔦",
	"Int;": "∬",
	"int;": "∫",
	Iuml: "Ï",
	iuml: "ï",
	"Jcy;": "Й",
	"jcy;": "й",
	"Jfr;": "𝔍",
	"jfr;": "𝔧",
	"Kcy;": "К",
	"kcy;": "к",
	"Kfr;": "𝔎",
	"kfr;": "𝔨",
	"lap;": "⪅",
	"lat;": "⪫",
	"Lcy;": "Л",
	"lcy;": "л",
	"lEg;": "⪋",
	"leg;": "⋚",
	"leq;": "≤",
	"les;": "⩽",
	"Lfr;": "𝔏",
	"lfr;": "𝔩",
	"lgE;": "⪑",
	"lnE;": "≨",
	"lne;": "⪇",
	"loz;": "◊",
	"lrm;": "‎",
	"Lsh;": "↰",
	"lsh;": "↰",
	macr: "¯",
	"Map;": "⤅",
	"map;": "↦",
	"Mcy;": "М",
	"mcy;": "м",
	"Mfr;": "𝔐",
	"mfr;": "𝔪",
	"mho;": "℧",
	"mid;": "∣",
	"nap;": "≉",
	nbsp: " ",
	"Ncy;": "Н",
	"ncy;": "н",
	"Nfr;": "𝔑",
	"nfr;": "𝔫",
	"ngE;": "≧̸",
	"nge;": "≱",
	"nGg;": "⋙̸",
	"nGt;": "≫⃒",
	"ngt;": "≯",
	"nis;": "⋼",
	"niv;": "∋",
	"nlE;": "≦̸",
	"nle;": "≰",
	"nLl;": "⋘̸",
	"nLt;": "≪⃒",
	"nlt;": "≮",
	"Not;": "⫬",
	"not;": "¬",
	"npr;": "⊀",
	"nsc;": "⊁",
	"num;": "#",
	"Ocy;": "О",
	"ocy;": "о",
	"Ofr;": "𝔒",
	"ofr;": "𝔬",
	"ogt;": "⧁",
	"ohm;": "Ω",
	"olt;": "⧀",
	"ord;": "⩝",
	ordf: "ª",
	ordm: "º",
	"orv;": "⩛",
	Ouml: "Ö",
	ouml: "ö",
	"par;": "∥",
	para: "¶",
	"Pcy;": "П",
	"pcy;": "п",
	"Pfr;": "𝔓",
	"pfr;": "𝔭",
	"Phi;": "Φ",
	"phi;": "φ",
	"piv;": "ϖ",
	"prE;": "⪳",
	"pre;": "⪯",
	"Psi;": "Ψ",
	"psi;": "ψ",
	"Qfr;": "𝔔",
	"qfr;": "𝔮",
	QUOT: "\"",
	quot: "\"",
	"Rcy;": "Р",
	"rcy;": "р",
	"REG;": "®",
	"reg;": "®",
	"Rfr;": "ℜ",
	"rfr;": "𝔯",
	"Rho;": "Ρ",
	"rho;": "ρ",
	"rlm;": "‏",
	"Rsh;": "↱",
	"rsh;": "↱",
	"scE;": "⪴",
	"sce;": "⪰",
	"Scy;": "С",
	"scy;": "с",
	sect: "§",
	"Sfr;": "𝔖",
	"sfr;": "𝔰",
	"shy;": "­",
	"sim;": "∼",
	"smt;": "⪪",
	"sol;": "/",
	"squ;": "□",
	"Sub;": "⋐",
	"sub;": "⊂",
	"Sum;": "∑",
	"sum;": "∑",
	"Sup;": "⋑",
	"sup;": "⊃",
	sup1: "¹",
	sup2: "²",
	sup3: "³",
	"Tab;": "\t",
	"Tau;": "Τ",
	"tau;": "τ",
	"Tcy;": "Т",
	"tcy;": "т",
	"Tfr;": "𝔗",
	"tfr;": "𝔱",
	"top;": "⊤",
	"Ucy;": "У",
	"ucy;": "у",
	"Ufr;": "𝔘",
	"ufr;": "𝔲",
	"uml;": "¨",
	Uuml: "Ü",
	uuml: "ü",
	"Vcy;": "В",
	"vcy;": "в",
	"Vee;": "⋁",
	"vee;": "∨",
	"Vfr;": "𝔙",
	"vfr;": "𝔳",
	"Wfr;": "𝔚",
	"wfr;": "𝔴",
	"Xfr;": "𝔛",
	"xfr;": "𝔵",
	"Ycy;": "Ы",
	"ycy;": "ы",
	"yen;": "¥",
	"Yfr;": "𝔜",
	"yfr;": "𝔶",
	yuml: "ÿ",
	"Zcy;": "З",
	"zcy;": "з",
	"Zfr;": "ℨ",
	"zfr;": "𝔷",
	"zwj;": "‍",
	Acirc: "Â",
	acirc: "â",
	acute: "´",
	AElig: "Æ",
	aelig: "æ",
	"andd;": "⩜",
	"andv;": "⩚",
	"ange;": "⦤",
	"Aopf;": "𝔸",
	"aopf;": "𝕒",
	"apid;": "≋",
	"apos;": "'",
	Aring: "Å",
	aring: "å",
	"Ascr;": "𝒜",
	"ascr;": "𝒶",
	"Auml;": "Ä",
	"auml;": "ä",
	"Barv;": "⫧",
	"bbrk;": "⎵",
	"Beta;": "Β",
	"beta;": "β",
	"beth;": "ℶ",
	"bNot;": "⫭",
	"bnot;": "⌐",
	"Bopf;": "𝔹",
	"bopf;": "𝕓",
	"boxH;": "═",
	"boxh;": "─",
	"boxV;": "║",
	"boxv;": "│",
	"Bscr;": "ℬ",
	"bscr;": "𝒷",
	"bsim;": "∽",
	"bsol;": "\\",
	"bull;": "•",
	"bump;": "≎",
	"caps;": "∩︀",
	"Cdot;": "Ċ",
	"cdot;": "ċ",
	cedil: "¸",
	"cent;": "¢",
	"CHcy;": "Ч",
	"chcy;": "ч",
	"circ;": "ˆ",
	"cirE;": "⧃",
	"cire;": "≗",
	"comp;": "∁",
	"cong;": "≅",
	"Copf;": "ℂ",
	"copf;": "𝕔",
	"COPY;": "©",
	"copy;": "©",
	"Cscr;": "𝒞",
	"cscr;": "𝒸",
	"csub;": "⫏",
	"csup;": "⫐",
	"cups;": "∪︀",
	"Darr;": "↡",
	"dArr;": "⇓",
	"darr;": "↓",
	"dash;": "‐",
	"dHar;": "⥥",
	"diam;": "⋄",
	"DJcy;": "Ђ",
	"djcy;": "ђ",
	"Dopf;": "𝔻",
	"dopf;": "𝕕",
	"Dscr;": "𝒟",
	"dscr;": "𝒹",
	"DScy;": "Ѕ",
	"dscy;": "ѕ",
	"dsol;": "⧶",
	"dtri;": "▿",
	"DZcy;": "Џ",
	"dzcy;": "џ",
	"ecir;": "≖",
	Ecirc: "Ê",
	ecirc: "ê",
	"Edot;": "Ė",
	"eDot;": "≑",
	"edot;": "ė",
	"emsp;": " ",
	"ensp;": " ",
	"Eopf;": "𝔼",
	"eopf;": "𝕖",
	"epar;": "⋕",
	"epsi;": "ε",
	"Escr;": "ℰ",
	"escr;": "ℯ",
	"Esim;": "⩳",
	"esim;": "≂",
	"Euml;": "Ë",
	"euml;": "ë",
	"euro;": "€",
	"excl;": "!",
	"flat;": "♭",
	"fnof;": "ƒ",
	"Fopf;": "𝔽",
	"fopf;": "𝕗",
	"fork;": "⋔",
	"Fscr;": "ℱ",
	"fscr;": "𝒻",
	"Gdot;": "Ġ",
	"gdot;": "ġ",
	"geqq;": "≧",
	"gesl;": "⋛︀",
	"GJcy;": "Ѓ",
	"gjcy;": "ѓ",
	"gnap;": "⪊",
	"gneq;": "⪈",
	"Gopf;": "𝔾",
	"gopf;": "𝕘",
	"Gscr;": "𝒢",
	"gscr;": "ℊ",
	"gsim;": "≳",
	"gtcc;": "⪧",
	"gvnE;": "≩︀",
	"half;": "½",
	"hArr;": "⇔",
	"harr;": "↔",
	"hbar;": "ℏ",
	"Hopf;": "ℍ",
	"hopf;": "𝕙",
	"Hscr;": "ℋ",
	"hscr;": "𝒽",
	Icirc: "Î",
	icirc: "î",
	"Idot;": "İ",
	"IEcy;": "Е",
	"iecy;": "е",
	iexcl: "¡",
	"imof;": "⊷",
	"IOcy;": "Ё",
	"iocy;": "ё",
	"Iopf;": "𝕀",
	"iopf;": "𝕚",
	"Iota;": "Ι",
	"iota;": "ι",
	"Iscr;": "ℐ",
	"iscr;": "𝒾",
	"isin;": "∈",
	"Iuml;": "Ï",
	"iuml;": "ï",
	"Jopf;": "𝕁",
	"jopf;": "𝕛",
	"Jscr;": "𝒥",
	"jscr;": "𝒿",
	"KHcy;": "Х",
	"khcy;": "х",
	"KJcy;": "Ќ",
	"kjcy;": "ќ",
	"Kopf;": "𝕂",
	"kopf;": "𝕜",
	"Kscr;": "𝒦",
	"kscr;": "𝓀",
	"Lang;": "⟪",
	"lang;": "⟨",
	laquo: "«",
	"Larr;": "↞",
	"lArr;": "⇐",
	"larr;": "←",
	"late;": "⪭",
	"lcub;": "{",
	"ldca;": "⤶",
	"ldsh;": "↲",
	"leqq;": "≦",
	"lesg;": "⋚︀",
	"lHar;": "⥢",
	"LJcy;": "Љ",
	"ljcy;": "љ",
	"lnap;": "⪉",
	"lneq;": "⪇",
	"Lopf;": "𝕃",
	"lopf;": "𝕝",
	"lozf;": "⧫",
	"lpar;": "(",
	"Lscr;": "ℒ",
	"lscr;": "𝓁",
	"lsim;": "≲",
	"lsqb;": "[",
	"ltcc;": "⪦",
	"ltri;": "◃",
	"lvnE;": "≨︀",
	"macr;": "¯",
	"male;": "♂",
	"malt;": "✠",
	micro: "µ",
	"mlcp;": "⫛",
	"mldr;": "…",
	"Mopf;": "𝕄",
	"mopf;": "𝕞",
	"Mscr;": "ℳ",
	"mscr;": "𝓂",
	"nang;": "∠⃒",
	"napE;": "⩰̸",
	"nbsp;": " ",
	"ncap;": "⩃",
	"ncup;": "⩂",
	"ngeq;": "≱",
	"nges;": "⩾̸",
	"ngtr;": "≯",
	"nGtv;": "≫̸",
	"nisd;": "⋺",
	"NJcy;": "Њ",
	"njcy;": "њ",
	"nldr;": "‥",
	"nleq;": "≰",
	"nles;": "⩽̸",
	"nLtv;": "≪̸",
	"nmid;": "∤",
	"Nopf;": "ℕ",
	"nopf;": "𝕟",
	"npar;": "∦",
	"npre;": "⪯̸",
	"nsce;": "⪰̸",
	"Nscr;": "𝒩",
	"nscr;": "𝓃",
	"nsim;": "≁",
	"nsub;": "⊄",
	"nsup;": "⊅",
	"ntgl;": "≹",
	"ntlg;": "≸",
	"nvap;": "≍⃒",
	"nvge;": "≥⃒",
	"nvgt;": ">⃒",
	"nvle;": "≤⃒",
	"nvlt;": "<⃒",
	"oast;": "⊛",
	"ocir;": "⊚",
	Ocirc: "Ô",
	ocirc: "ô",
	"odiv;": "⨸",
	"odot;": "⊙",
	"ogon;": "˛",
	"oint;": "∮",
	"omid;": "⦶",
	"Oopf;": "𝕆",
	"oopf;": "𝕠",
	"opar;": "⦷",
	"ordf;": "ª",
	"ordm;": "º",
	"oror;": "⩖",
	"Oscr;": "𝒪",
	"oscr;": "ℴ",
	"osol;": "⊘",
	"Ouml;": "Ö",
	"ouml;": "ö",
	"para;": "¶",
	"part;": "∂",
	"perp;": "⊥",
	"phiv;": "ϕ",
	"plus;": "+",
	"Popf;": "ℙ",
	"popf;": "𝕡",
	pound: "£",
	"prap;": "⪷",
	"prec;": "≺",
	"prnE;": "⪵",
	"prod;": "∏",
	"prop;": "∝",
	"Pscr;": "𝒫",
	"pscr;": "𝓅",
	"qint;": "⨌",
	"Qopf;": "ℚ",
	"qopf;": "𝕢",
	"Qscr;": "𝒬",
	"qscr;": "𝓆",
	"QUOT;": "\"",
	"quot;": "\"",
	"race;": "∽̱",
	"Rang;": "⟫",
	"rang;": "⟩",
	raquo: "»",
	"Rarr;": "↠",
	"rArr;": "⇒",
	"rarr;": "→",
	"rcub;": "}",
	"rdca;": "⤷",
	"rdsh;": "↳",
	"real;": "ℜ",
	"rect;": "▭",
	"rHar;": "⥤",
	"rhov;": "ϱ",
	"ring;": "˚",
	"Ropf;": "ℝ",
	"ropf;": "𝕣",
	"rpar;": ")",
	"Rscr;": "ℛ",
	"rscr;": "𝓇",
	"rsqb;": "]",
	"rtri;": "▹",
	"scap;": "⪸",
	"scnE;": "⪶",
	"sdot;": "⋅",
	"sect;": "§",
	"semi;": ";",
	"sext;": "✶",
	"SHcy;": "Ш",
	"shcy;": "ш",
	"sime;": "≃",
	"simg;": "⪞",
	"siml;": "⪝",
	"smid;": "∣",
	"smte;": "⪬",
	"solb;": "⧄",
	"Sopf;": "𝕊",
	"sopf;": "𝕤",
	"spar;": "∥",
	"Sqrt;": "√",
	"squf;": "▪",
	"Sscr;": "𝒮",
	"sscr;": "𝓈",
	"Star;": "⋆",
	"star;": "☆",
	"subE;": "⫅",
	"sube;": "⊆",
	"succ;": "≻",
	"sung;": "♪",
	"sup1;": "¹",
	"sup2;": "²",
	"sup3;": "³",
	"supE;": "⫆",
	"supe;": "⊇",
	szlig: "ß",
	"tbrk;": "⎴",
	"tdot;": "⃛",
	THORN: "Þ",
	thorn: "þ",
	times: "×",
	"tint;": "∭",
	"toea;": "⤨",
	"Topf;": "𝕋",
	"topf;": "𝕥",
	"tosa;": "⤩",
	"trie;": "≜",
	"Tscr;": "𝒯",
	"tscr;": "𝓉",
	"TScy;": "Ц",
	"tscy;": "ц",
	"Uarr;": "↟",
	"uArr;": "⇑",
	"uarr;": "↑",
	Ucirc: "Û",
	ucirc: "û",
	"uHar;": "⥣",
	"Uopf;": "𝕌",
	"uopf;": "𝕦",
	"Upsi;": "ϒ",
	"upsi;": "υ",
	"Uscr;": "𝒰",
	"uscr;": "𝓊",
	"utri;": "▵",
	"Uuml;": "Ü",
	"uuml;": "ü",
	"vArr;": "⇕",
	"varr;": "↕",
	"Vbar;": "⫫",
	"vBar;": "⫨",
	"Vert;": "‖",
	"vert;": "|",
	"Vopf;": "𝕍",
	"vopf;": "𝕧",
	"Vscr;": "𝒱",
	"vscr;": "𝓋",
	"Wopf;": "𝕎",
	"wopf;": "𝕨",
	"Wscr;": "𝒲",
	"wscr;": "𝓌",
	"xcap;": "⋂",
	"xcup;": "⋃",
	"xmap;": "⟼",
	"xnis;": "⋻",
	"Xopf;": "𝕏",
	"xopf;": "𝕩",
	"Xscr;": "𝒳",
	"xscr;": "𝓍",
	"xvee;": "⋁",
	"YAcy;": "Я",
	"yacy;": "я",
	"YIcy;": "Ї",
	"yicy;": "ї",
	"Yopf;": "𝕐",
	"yopf;": "𝕪",
	"Yscr;": "𝒴",
	"yscr;": "𝓎",
	"YUcy;": "Ю",
	"yucy;": "ю",
	"Yuml;": "Ÿ",
	"yuml;": "ÿ",
	"Zdot;": "Ż",
	"zdot;": "ż",
	"Zeta;": "Ζ",
	"zeta;": "ζ",
	"ZHcy;": "Ж",
	"zhcy;": "ж",
	"Zopf;": "ℤ",
	"zopf;": "𝕫",
	"Zscr;": "𝒵",
	"zscr;": "𝓏",
	"zwnj;": "‌",
	Aacute: "Á",
	aacute: "á",
	"Acirc;": "Â",
	"acirc;": "â",
	"acute;": "´",
	"AElig;": "Æ",
	"aelig;": "æ",
	Agrave: "À",
	agrave: "à",
	"aleph;": "ℵ",
	"Alpha;": "Α",
	"alpha;": "α",
	"Amacr;": "Ā",
	"amacr;": "ā",
	"amalg;": "⨿",
	"angle;": "∠",
	"angrt;": "∟",
	"angst;": "Å",
	"Aogon;": "Ą",
	"aogon;": "ą",
	"Aring;": "Å",
	"aring;": "å",
	"asymp;": "≈",
	Atilde: "Ã",
	atilde: "ã",
	"awint;": "⨑",
	"bcong;": "≌",
	"bdquo;": "„",
	"bepsi;": "϶",
	"blank;": "␣",
	"blk12;": "▒",
	"blk14;": "░",
	"blk34;": "▓",
	"block;": "█",
	"boxDL;": "╗",
	"boxDl;": "╖",
	"boxdL;": "╕",
	"boxdl;": "┐",
	"boxDR;": "╔",
	"boxDr;": "╓",
	"boxdR;": "╒",
	"boxdr;": "┌",
	"boxHD;": "╦",
	"boxHd;": "╤",
	"boxhD;": "╥",
	"boxhd;": "┬",
	"boxHU;": "╩",
	"boxHu;": "╧",
	"boxhU;": "╨",
	"boxhu;": "┴",
	"boxUL;": "╝",
	"boxUl;": "╜",
	"boxuL;": "╛",
	"boxul;": "┘",
	"boxUR;": "╚",
	"boxUr;": "╙",
	"boxuR;": "╘",
	"boxur;": "└",
	"boxVH;": "╬",
	"boxVh;": "╫",
	"boxvH;": "╪",
	"boxvh;": "┼",
	"boxVL;": "╣",
	"boxVl;": "╢",
	"boxvL;": "╡",
	"boxvl;": "┤",
	"boxVR;": "╠",
	"boxVr;": "╟",
	"boxvR;": "╞",
	"boxvr;": "├",
	"Breve;": "˘",
	"breve;": "˘",
	brvbar: "¦",
	"bsemi;": "⁏",
	"bsime;": "⋍",
	"bsolb;": "⧅",
	"bumpE;": "⪮",
	"bumpe;": "≏",
	"caret;": "⁁",
	"caron;": "ˇ",
	"ccaps;": "⩍",
	Ccedil: "Ç",
	ccedil: "ç",
	"Ccirc;": "Ĉ",
	"ccirc;": "ĉ",
	"ccups;": "⩌",
	"cedil;": "¸",
	"check;": "✓",
	"clubs;": "♣",
	"Colon;": "∷",
	"colon;": ":",
	"comma;": ",",
	"crarr;": "↵",
	"Cross;": "⨯",
	"cross;": "✗",
	"csube;": "⫑",
	"csupe;": "⫒",
	"ctdot;": "⋯",
	"cuepr;": "⋞",
	"cuesc;": "⋟",
	"cupor;": "⩅",
	curren: "¤",
	"cuvee;": "⋎",
	"cuwed;": "⋏",
	"cwint;": "∱",
	"Dashv;": "⫤",
	"dashv;": "⊣",
	"dblac;": "˝",
	"ddarr;": "⇊",
	"Delta;": "Δ",
	"delta;": "δ",
	"dharl;": "⇃",
	"dharr;": "⇂",
	"diams;": "♦",
	"disin;": "⋲",
	divide: "÷",
	"doteq;": "≐",
	"dtdot;": "⋱",
	"dtrif;": "▾",
	"duarr;": "⇵",
	"duhar;": "⥯",
	Eacute: "É",
	eacute: "é",
	"Ecirc;": "Ê",
	"ecirc;": "ê",
	"eDDot;": "⩷",
	"efDot;": "≒",
	Egrave: "È",
	egrave: "è",
	"Emacr;": "Ē",
	"emacr;": "ē",
	"empty;": "∅",
	"Eogon;": "Ę",
	"eogon;": "ę",
	"eplus;": "⩱",
	"epsiv;": "ϵ",
	"eqsim;": "≂",
	"Equal;": "⩵",
	"equiv;": "≡",
	"erarr;": "⥱",
	"erDot;": "≓",
	"esdot;": "≐",
	"exist;": "∃",
	"fflig;": "ﬀ",
	"filig;": "ﬁ",
	"fjlig;": "fj",
	"fllig;": "ﬂ",
	"fltns;": "▱",
	"forkv;": "⫙",
	frac12: "½",
	frac14: "¼",
	frac34: "¾",
	"frasl;": "⁄",
	"frown;": "⌢",
	"Gamma;": "Γ",
	"gamma;": "γ",
	"Gcirc;": "Ĝ",
	"gcirc;": "ĝ",
	"gescc;": "⪩",
	"gimel;": "ℷ",
	"gneqq;": "≩",
	"gnsim;": "⋧",
	"grave;": "`",
	"gsime;": "⪎",
	"gsiml;": "⪐",
	"gtcir;": "⩺",
	"gtdot;": "⋗",
	"Hacek;": "ˇ",
	"harrw;": "↭",
	"Hcirc;": "Ĥ",
	"hcirc;": "ĥ",
	"hoarr;": "⇿",
	Iacute: "Í",
	iacute: "í",
	"Icirc;": "Î",
	"icirc;": "î",
	"iexcl;": "¡",
	Igrave: "Ì",
	igrave: "ì",
	"iiint;": "∭",
	"iiota;": "℩",
	"IJlig;": "Ĳ",
	"ijlig;": "ĳ",
	"Imacr;": "Ī",
	"imacr;": "ī",
	"image;": "ℑ",
	"imath;": "ı",
	"imped;": "Ƶ",
	"infin;": "∞",
	"Iogon;": "Į",
	"iogon;": "į",
	"iprod;": "⨼",
	iquest: "¿",
	"isinE;": "⋹",
	"isins;": "⋴",
	"isinv;": "∈",
	"Iukcy;": "І",
	"iukcy;": "і",
	"Jcirc;": "Ĵ",
	"jcirc;": "ĵ",
	"jmath;": "ȷ",
	"Jukcy;": "Є",
	"jukcy;": "є",
	"Kappa;": "Κ",
	"kappa;": "κ",
	"lAarr;": "⇚",
	"langd;": "⦑",
	"laquo;": "«",
	"larrb;": "⇤",
	"lates;": "⪭︀",
	"lBarr;": "⤎",
	"lbarr;": "⤌",
	"lbbrk;": "❲",
	"lbrke;": "⦋",
	"lceil;": "⌈",
	"ldquo;": "“",
	"lescc;": "⪨",
	"lhard;": "↽",
	"lharu;": "↼",
	"lhblk;": "▄",
	"llarr;": "⇇",
	"lltri;": "◺",
	"lneqq;": "≨",
	"lnsim;": "⋦",
	"loang;": "⟬",
	"loarr;": "⇽",
	"lobrk;": "⟦",
	"lopar;": "⦅",
	"lrarr;": "⇆",
	"lrhar;": "⇋",
	"lrtri;": "⊿",
	"lsime;": "⪍",
	"lsimg;": "⪏",
	"lsquo;": "‘",
	"ltcir;": "⩹",
	"ltdot;": "⋖",
	"ltrie;": "⊴",
	"ltrif;": "◂",
	"mdash;": "—",
	"mDDot;": "∺",
	"micro;": "µ",
	middot: "·",
	"minus;": "−",
	"mumap;": "⊸",
	"nabla;": "∇",
	"napid;": "≋̸",
	"napos;": "ŉ",
	"natur;": "♮",
	"nbump;": "≎̸",
	"ncong;": "≇",
	"ndash;": "–",
	"neArr;": "⇗",
	"nearr;": "↗",
	"nedot;": "≐̸",
	"nesim;": "≂̸",
	"ngeqq;": "≧̸",
	"ngsim;": "≵",
	"nhArr;": "⇎",
	"nharr;": "↮",
	"nhpar;": "⫲",
	"nlArr;": "⇍",
	"nlarr;": "↚",
	"nleqq;": "≦̸",
	"nless;": "≮",
	"nlsim;": "≴",
	"nltri;": "⋪",
	"notin;": "∉",
	"notni;": "∌",
	"npart;": "∂̸",
	"nprec;": "⊀",
	"nrArr;": "⇏",
	"nrarr;": "↛",
	"nrtri;": "⋫",
	"nsime;": "≄",
	"nsmid;": "∤",
	"nspar;": "∦",
	"nsubE;": "⫅̸",
	"nsube;": "⊈",
	"nsucc;": "⊁",
	"nsupE;": "⫆̸",
	"nsupe;": "⊉",
	Ntilde: "Ñ",
	ntilde: "ñ",
	"numsp;": " ",
	"nvsim;": "∼⃒",
	"nwArr;": "⇖",
	"nwarr;": "↖",
	Oacute: "Ó",
	oacute: "ó",
	"Ocirc;": "Ô",
	"ocirc;": "ô",
	"odash;": "⊝",
	"OElig;": "Œ",
	"oelig;": "œ",
	"ofcir;": "⦿",
	Ograve: "Ò",
	ograve: "ò",
	"ohbar;": "⦵",
	"olarr;": "↺",
	"olcir;": "⦾",
	"oline;": "‾",
	"Omacr;": "Ō",
	"omacr;": "ō",
	"Omega;": "Ω",
	"omega;": "ω",
	"operp;": "⦹",
	"oplus;": "⊕",
	"orarr;": "↻",
	"order;": "ℴ",
	Oslash: "Ø",
	oslash: "ø",
	Otilde: "Õ",
	otilde: "õ",
	"ovbar;": "⌽",
	"parsl;": "⫽",
	"phone;": "☎",
	"plusb;": "⊞",
	"pluse;": "⩲",
	plusmn: "±",
	"pound;": "£",
	"prcue;": "≼",
	"Prime;": "″",
	"prime;": "′",
	"prnap;": "⪹",
	"prsim;": "≾",
	"quest;": "?",
	"rAarr;": "⇛",
	"radic;": "√",
	"rangd;": "⦒",
	"range;": "⦥",
	"raquo;": "»",
	"rarrb;": "⇥",
	"rarrc;": "⤳",
	"rarrw;": "↝",
	"ratio;": "∶",
	"RBarr;": "⤐",
	"rBarr;": "⤏",
	"rbarr;": "⤍",
	"rbbrk;": "❳",
	"rbrke;": "⦌",
	"rceil;": "⌉",
	"rdquo;": "”",
	"reals;": "ℝ",
	"rhard;": "⇁",
	"rharu;": "⇀",
	"rlarr;": "⇄",
	"rlhar;": "⇌",
	"rnmid;": "⫮",
	"roang;": "⟭",
	"roarr;": "⇾",
	"robrk;": "⟧",
	"ropar;": "⦆",
	"rrarr;": "⇉",
	"rsquo;": "’",
	"rtrie;": "⊵",
	"rtrif;": "▸",
	"sbquo;": "‚",
	"sccue;": "≽",
	"Scirc;": "Ŝ",
	"scirc;": "ŝ",
	"scnap;": "⪺",
	"scsim;": "≿",
	"sdotb;": "⊡",
	"sdote;": "⩦",
	"seArr;": "⇘",
	"searr;": "↘",
	"setmn;": "∖",
	"sharp;": "♯",
	"Sigma;": "Σ",
	"sigma;": "σ",
	"simeq;": "≃",
	"simgE;": "⪠",
	"simlE;": "⪟",
	"simne;": "≆",
	"slarr;": "←",
	"smile;": "⌣",
	"smtes;": "⪬︀",
	"sqcap;": "⊓",
	"sqcup;": "⊔",
	"sqsub;": "⊏",
	"sqsup;": "⊐",
	"srarr;": "→",
	"starf;": "★",
	"strns;": "¯",
	"subnE;": "⫋",
	"subne;": "⊊",
	"supnE;": "⫌",
	"supne;": "⊋",
	"swArr;": "⇙",
	"swarr;": "↙",
	"szlig;": "ß",
	"Theta;": "Θ",
	"theta;": "θ",
	"thkap;": "≈",
	"THORN;": "Þ",
	"thorn;": "þ",
	"Tilde;": "∼",
	"tilde;": "˜",
	"times;": "×",
	"TRADE;": "™",
	"trade;": "™",
	"trisb;": "⧍",
	"TSHcy;": "Ћ",
	"tshcy;": "ћ",
	"twixt;": "≬",
	Uacute: "Ú",
	uacute: "ú",
	"Ubrcy;": "Ў",
	"ubrcy;": "ў",
	"Ucirc;": "Û",
	"ucirc;": "û",
	"udarr;": "⇅",
	"udhar;": "⥮",
	Ugrave: "Ù",
	ugrave: "ù",
	"uharl;": "↿",
	"uharr;": "↾",
	"uhblk;": "▀",
	"ultri;": "◸",
	"Umacr;": "Ū",
	"umacr;": "ū",
	"Union;": "⋃",
	"Uogon;": "Ų",
	"uogon;": "ų",
	"uplus;": "⊎",
	"upsih;": "ϒ",
	"UpTee;": "⊥",
	"Uring;": "Ů",
	"uring;": "ů",
	"urtri;": "◹",
	"utdot;": "⋰",
	"utrif;": "▴",
	"uuarr;": "⇈",
	"varpi;": "ϖ",
	"vBarv;": "⫩",
	"VDash;": "⊫",
	"Vdash;": "⊩",
	"vDash;": "⊨",
	"vdash;": "⊢",
	"veeeq;": "≚",
	"vltri;": "⊲",
	"vnsub;": "⊂⃒",
	"vnsup;": "⊃⃒",
	"vprop;": "∝",
	"vrtri;": "⊳",
	"Wcirc;": "Ŵ",
	"wcirc;": "ŵ",
	"Wedge;": "⋀",
	"wedge;": "∧",
	"xcirc;": "◯",
	"xdtri;": "▽",
	"xhArr;": "⟺",
	"xharr;": "⟷",
	"xlArr;": "⟸",
	"xlarr;": "⟵",
	"xodot;": "⨀",
	"xrArr;": "⟹",
	"xrarr;": "⟶",
	"xutri;": "△",
	Yacute: "Ý",
	yacute: "ý",
	"Ycirc;": "Ŷ",
	"ycirc;": "ŷ",
	"Aacute;": "Á",
	"aacute;": "á",
	"Abreve;": "Ă",
	"abreve;": "ă",
	"Agrave;": "À",
	"agrave;": "à",
	"andand;": "⩕",
	"angmsd;": "∡",
	"angsph;": "∢",
	"apacir;": "⩯",
	"approx;": "≈",
	"Assign;": "≔",
	"Atilde;": "Ã",
	"atilde;": "ã",
	"barvee;": "⊽",
	"Barwed;": "⌆",
	"barwed;": "⌅",
	"becaus;": "∵",
	"bernou;": "ℬ",
	"bigcap;": "⋂",
	"bigcup;": "⋃",
	"bigvee;": "⋁",
	"bkarow;": "⤍",
	"bottom;": "⊥",
	"bowtie;": "⋈",
	"boxbox;": "⧉",
	"bprime;": "‵",
	"brvbar;": "¦",
	"bullet;": "•",
	"Bumpeq;": "≎",
	"bumpeq;": "≏",
	"Cacute;": "Ć",
	"cacute;": "ć",
	"capand;": "⩄",
	"capcap;": "⩋",
	"capcup;": "⩇",
	"capdot;": "⩀",
	"Ccaron;": "Č",
	"ccaron;": "č",
	"Ccedil;": "Ç",
	"ccedil;": "ç",
	"circeq;": "≗",
	"cirmid;": "⫯",
	"Colone;": "⩴",
	"colone;": "≔",
	"commat;": "@",
	"compfn;": "∘",
	"Conint;": "∯",
	"conint;": "∮",
	"coprod;": "∐",
	"copysr;": "℗",
	"cularr;": "↶",
	"CupCap;": "≍",
	"cupcap;": "⩆",
	"cupcup;": "⩊",
	"cupdot;": "⊍",
	"curarr;": "↷",
	"curren;": "¤",
	"cylcty;": "⌭",
	"Dagger;": "‡",
	"dagger;": "†",
	"daleth;": "ℸ",
	"Dcaron;": "Ď",
	"dcaron;": "ď",
	"dfisht;": "⥿",
	"divide;": "÷",
	"divonx;": "⋇",
	"dlcorn;": "⌞",
	"dlcrop;": "⌍",
	"dollar;": "$",
	"DotDot;": "⃜",
	"drcorn;": "⌟",
	"drcrop;": "⌌",
	"Dstrok;": "Đ",
	"dstrok;": "đ",
	"Eacute;": "É",
	"eacute;": "é",
	"easter;": "⩮",
	"Ecaron;": "Ě",
	"ecaron;": "ě",
	"ecolon;": "≕",
	"Egrave;": "È",
	"egrave;": "è",
	"egsdot;": "⪘",
	"elsdot;": "⪗",
	"emptyv;": "∅",
	"emsp13;": " ",
	"emsp14;": " ",
	"eparsl;": "⧣",
	"eqcirc;": "≖",
	"equals;": "=",
	"equest;": "≟",
	"Exists;": "∃",
	"female;": "♀",
	"ffilig;": "ﬃ",
	"ffllig;": "ﬄ",
	"ForAll;": "∀",
	"forall;": "∀",
	"frac12;": "½",
	"frac13;": "⅓",
	"frac14;": "¼",
	"frac15;": "⅕",
	"frac16;": "⅙",
	"frac18;": "⅛",
	"frac23;": "⅔",
	"frac25;": "⅖",
	"frac34;": "¾",
	"frac35;": "⅗",
	"frac38;": "⅜",
	"frac45;": "⅘",
	"frac56;": "⅚",
	"frac58;": "⅝",
	"frac78;": "⅞",
	"gacute;": "ǵ",
	"Gammad;": "Ϝ",
	"gammad;": "ϝ",
	"Gbreve;": "Ğ",
	"gbreve;": "ğ",
	"Gcedil;": "Ģ",
	"gesdot;": "⪀",
	"gesles;": "⪔",
	"gtlPar;": "⦕",
	"gtrarr;": "⥸",
	"gtrdot;": "⋗",
	"gtrsim;": "≳",
	"hairsp;": " ",
	"hamilt;": "ℋ",
	"HARDcy;": "Ъ",
	"hardcy;": "ъ",
	"hearts;": "♥",
	"hellip;": "…",
	"hercon;": "⊹",
	"homtht;": "∻",
	"horbar;": "―",
	"hslash;": "ℏ",
	"Hstrok;": "Ħ",
	"hstrok;": "ħ",
	"hybull;": "⁃",
	"hyphen;": "‐",
	"Iacute;": "Í",
	"iacute;": "í",
	"Igrave;": "Ì",
	"igrave;": "ì",
	"iiiint;": "⨌",
	"iinfin;": "⧜",
	"incare;": "℅",
	"inodot;": "ı",
	"intcal;": "⊺",
	"iquest;": "¿",
	"isinsv;": "⋳",
	"Itilde;": "Ĩ",
	"itilde;": "ĩ",
	"Jsercy;": "Ј",
	"jsercy;": "ј",
	"kappav;": "ϰ",
	"Kcedil;": "Ķ",
	"kcedil;": "ķ",
	"kgreen;": "ĸ",
	"Lacute;": "Ĺ",
	"lacute;": "ĺ",
	"lagran;": "ℒ",
	"Lambda;": "Λ",
	"lambda;": "λ",
	"langle;": "⟨",
	"larrfs;": "⤝",
	"larrhk;": "↩",
	"larrlp;": "↫",
	"larrpl;": "⤹",
	"larrtl;": "↢",
	"lAtail;": "⤛",
	"latail;": "⤙",
	"lbrace;": "{",
	"lbrack;": "[",
	"Lcaron;": "Ľ",
	"lcaron;": "ľ",
	"Lcedil;": "Ļ",
	"lcedil;": "ļ",
	"ldquor;": "„",
	"lesdot;": "⩿",
	"lesges;": "⪓",
	"lfisht;": "⥼",
	"lfloor;": "⌊",
	"lharul;": "⥪",
	"llhard;": "⥫",
	"Lmidot;": "Ŀ",
	"lmidot;": "ŀ",
	"lmoust;": "⎰",
	"loplus;": "⨭",
	"lowast;": "∗",
	"lowbar;": "_",
	"lparlt;": "⦓",
	"lrhard;": "⥭",
	"lsaquo;": "‹",
	"lsquor;": "‚",
	"Lstrok;": "Ł",
	"lstrok;": "ł",
	"lthree;": "⋋",
	"ltimes;": "⋉",
	"ltlarr;": "⥶",
	"ltrPar;": "⦖",
	"mapsto;": "↦",
	"marker;": "▮",
	"mcomma;": "⨩",
	"midast;": "*",
	"midcir;": "⫰",
	"middot;": "·",
	"minusb;": "⊟",
	"minusd;": "∸",
	"mnplus;": "∓",
	"models;": "⊧",
	"mstpos;": "∾",
	"Nacute;": "Ń",
	"nacute;": "ń",
	"nbumpe;": "≏̸",
	"Ncaron;": "Ň",
	"ncaron;": "ň",
	"Ncedil;": "Ņ",
	"ncedil;": "ņ",
	"nearhk;": "⤤",
	"nequiv;": "≢",
	"nesear;": "⤨",
	"nexist;": "∄",
	"nltrie;": "⋬",
	"notinE;": "⋹̸",
	"nparsl;": "⫽⃥",
	"nprcue;": "⋠",
	"nrarrc;": "⤳̸",
	"nrarrw;": "↝̸",
	"nrtrie;": "⋭",
	"nsccue;": "⋡",
	"nsimeq;": "≄",
	"Ntilde;": "Ñ",
	"ntilde;": "ñ",
	"numero;": "№",
	"nVDash;": "⊯",
	"nVdash;": "⊮",
	"nvDash;": "⊭",
	"nvdash;": "⊬",
	"nvHarr;": "⤄",
	"nvlArr;": "⤂",
	"nvrArr;": "⤃",
	"nwarhk;": "⤣",
	"nwnear;": "⤧",
	"Oacute;": "Ó",
	"oacute;": "ó",
	"Odblac;": "Ő",
	"odblac;": "ő",
	"odsold;": "⦼",
	"Ograve;": "Ò",
	"ograve;": "ò",
	"ominus;": "⊖",
	"origof;": "⊶",
	"Oslash;": "Ø",
	"oslash;": "ø",
	"Otilde;": "Õ",
	"otilde;": "õ",
	"Otimes;": "⨷",
	"otimes;": "⊗",
	"parsim;": "⫳",
	"percnt;": "%",
	"period;": ".",
	"permil;": "‰",
	"phmmat;": "ℳ",
	"planck;": "ℏ",
	"plankv;": "ℏ",
	"plusdo;": "∔",
	"plusdu;": "⨥",
	"plusmn;": "±",
	"preceq;": "⪯",
	"primes;": "ℙ",
	"prnsim;": "⋨",
	"propto;": "∝",
	"prurel;": "⊰",
	"puncsp;": " ",
	"qprime;": "⁗",
	"Racute;": "Ŕ",
	"racute;": "ŕ",
	"rangle;": "⟩",
	"rarrap;": "⥵",
	"rarrfs;": "⤞",
	"rarrhk;": "↪",
	"rarrlp;": "↬",
	"rarrpl;": "⥅",
	"Rarrtl;": "⤖",
	"rarrtl;": "↣",
	"rAtail;": "⤜",
	"ratail;": "⤚",
	"rbrace;": "}",
	"rbrack;": "]",
	"Rcaron;": "Ř",
	"rcaron;": "ř",
	"Rcedil;": "Ŗ",
	"rcedil;": "ŗ",
	"rdquor;": "”",
	"rfisht;": "⥽",
	"rfloor;": "⌋",
	"rharul;": "⥬",
	"rmoust;": "⎱",
	"roplus;": "⨮",
	"rpargt;": "⦔",
	"rsaquo;": "›",
	"rsquor;": "’",
	"rthree;": "⋌",
	"rtimes;": "⋊",
	"Sacute;": "Ś",
	"sacute;": "ś",
	"Scaron;": "Š",
	"scaron;": "š",
	"Scedil;": "Ş",
	"scedil;": "ş",
	"scnsim;": "⋩",
	"searhk;": "⤥",
	"seswar;": "⤩",
	"sfrown;": "⌢",
	"SHCHcy;": "Щ",
	"shchcy;": "щ",
	"sigmaf;": "ς",
	"sigmav;": "ς",
	"simdot;": "⩪",
	"smashp;": "⨳",
	"SOFTcy;": "Ь",
	"softcy;": "ь",
	"solbar;": "⌿",
	"spades;": "♠",
	"sqcaps;": "⊓︀",
	"sqcups;": "⊔︀",
	"sqsube;": "⊑",
	"sqsupe;": "⊒",
	"Square;": "□",
	"square;": "□",
	"squarf;": "▪",
	"ssetmn;": "∖",
	"ssmile;": "⌣",
	"sstarf;": "⋆",
	"subdot;": "⪽",
	"Subset;": "⋐",
	"subset;": "⊂",
	"subsim;": "⫇",
	"subsub;": "⫕",
	"subsup;": "⫓",
	"succeq;": "⪰",
	"supdot;": "⪾",
	"Supset;": "⋑",
	"supset;": "⊃",
	"supsim;": "⫈",
	"supsub;": "⫔",
	"supsup;": "⫖",
	"swarhk;": "⤦",
	"swnwar;": "⤪",
	"target;": "⌖",
	"Tcaron;": "Ť",
	"tcaron;": "ť",
	"Tcedil;": "Ţ",
	"tcedil;": "ţ",
	"telrec;": "⌕",
	"there4;": "∴",
	"thetav;": "ϑ",
	"thinsp;": " ",
	"thksim;": "∼",
	"timesb;": "⊠",
	"timesd;": "⨰",
	"topbot;": "⌶",
	"topcir;": "⫱",
	"tprime;": "‴",
	"tridot;": "◬",
	"Tstrok;": "Ŧ",
	"tstrok;": "ŧ",
	"Uacute;": "Ú",
	"uacute;": "ú",
	"Ubreve;": "Ŭ",
	"ubreve;": "ŭ",
	"Udblac;": "Ű",
	"udblac;": "ű",
	"ufisht;": "⥾",
	"Ugrave;": "Ù",
	"ugrave;": "ù",
	"ulcorn;": "⌜",
	"ulcrop;": "⌏",
	"urcorn;": "⌝",
	"urcrop;": "⌎",
	"Utilde;": "Ũ",
	"utilde;": "ũ",
	"vangrt;": "⦜",
	"varphi;": "ϕ",
	"varrho;": "ϱ",
	"Vdashl;": "⫦",
	"veebar;": "⊻",
	"vellip;": "⋮",
	"Verbar;": "‖",
	"verbar;": "|",
	"vsubnE;": "⫋︀",
	"vsubne;": "⊊︀",
	"vsupnE;": "⫌︀",
	"vsupne;": "⊋︀",
	"Vvdash;": "⊪",
	"wedbar;": "⩟",
	"wedgeq;": "≙",
	"weierp;": "℘",
	"wreath;": "≀",
	"xoplus;": "⨁",
	"xotime;": "⨂",
	"xsqcup;": "⨆",
	"xuplus;": "⨄",
	"xwedge;": "⋀",
	"Yacute;": "Ý",
	"yacute;": "ý",
	"Zacute;": "Ź",
	"zacute;": "ź",
	"Zcaron;": "Ž",
	"zcaron;": "ž",
	"zeetrf;": "ℨ",
	"alefsym;": "ℵ",
	"angrtvb;": "⊾",
	"angzarr;": "⍼",
	"asympeq;": "≍",
	"backsim;": "∽",
	"Because;": "∵",
	"because;": "∵",
	"bemptyv;": "⦰",
	"between;": "≬",
	"bigcirc;": "◯",
	"bigodot;": "⨀",
	"bigstar;": "★",
	"bnequiv;": "≡⃥",
	"boxplus;": "⊞",
	"Cayleys;": "ℭ",
	"Cconint;": "∰",
	"ccupssm;": "⩐",
	"Cedilla;": "¸",
	"cemptyv;": "⦲",
	"cirscir;": "⧂",
	"coloneq;": "≔",
	"congdot;": "⩭",
	"cudarrl;": "⤸",
	"cudarrr;": "⤵",
	"cularrp;": "⤽",
	"curarrm;": "⤼",
	"dbkarow;": "⤏",
	"ddagger;": "‡",
	"ddotseq;": "⩷",
	"demptyv;": "⦱",
	"Diamond;": "⋄",
	"diamond;": "⋄",
	"digamma;": "ϝ",
	"dotplus;": "∔",
	"DownTee;": "⊤",
	"dwangle;": "⦦",
	"Element;": "∈",
	"Epsilon;": "Ε",
	"epsilon;": "ε",
	"eqcolon;": "≕",
	"equivDD;": "⩸",
	"gesdoto;": "⪂",
	"gtquest;": "⩼",
	"gtrless;": "≷",
	"harrcir;": "⥈",
	"Implies;": "⇒",
	"intprod;": "⨼",
	"isindot;": "⋵",
	"larrbfs;": "⤟",
	"larrsim;": "⥳",
	"lbrksld;": "⦏",
	"lbrkslu;": "⦍",
	"ldrdhar;": "⥧",
	"LeftTee;": "⊣",
	"lesdoto;": "⪁",
	"lessdot;": "⋖",
	"lessgtr;": "≶",
	"lesssim;": "≲",
	"lotimes;": "⨴",
	"lozenge;": "◊",
	"ltquest;": "⩻",
	"luruhar;": "⥦",
	"maltese;": "✠",
	"minusdu;": "⨪",
	"napprox;": "≉",
	"natural;": "♮",
	"nearrow;": "↗",
	"NewLine;": "\n",
	"nexists;": "∄",
	"NoBreak;": "⁠",
	"notinva;": "∉",
	"notinvb;": "⋷",
	"notinvc;": "⋶",
	"NotLess;": "≮",
	"notniva;": "∌",
	"notnivb;": "⋾",
	"notnivc;": "⋽",
	"npolint;": "⨔",
	"npreceq;": "⪯̸",
	"nsqsube;": "⋢",
	"nsqsupe;": "⋣",
	"nsubset;": "⊂⃒",
	"nsucceq;": "⪰̸",
	"nsupset;": "⊃⃒",
	"nvinfin;": "⧞",
	"nvltrie;": "⊴⃒",
	"nvrtrie;": "⊵⃒",
	"nwarrow;": "↖",
	"olcross;": "⦻",
	"Omicron;": "Ο",
	"omicron;": "ο",
	"orderof;": "ℴ",
	"orslope;": "⩗",
	"OverBar;": "‾",
	"pertenk;": "‱",
	"planckh;": "ℎ",
	"pluscir;": "⨢",
	"plussim;": "⨦",
	"plustwo;": "⨧",
	"precsim;": "≾",
	"Product;": "∏",
	"quatint;": "⨖",
	"questeq;": "≟",
	"rarrbfs;": "⤠",
	"rarrsim;": "⥴",
	"rbrksld;": "⦎",
	"rbrkslu;": "⦐",
	"rdldhar;": "⥩",
	"realine;": "ℛ",
	"rotimes;": "⨵",
	"ruluhar;": "⥨",
	"searrow;": "↘",
	"simplus;": "⨤",
	"simrarr;": "⥲",
	"subedot;": "⫃",
	"submult;": "⫁",
	"subplus;": "⪿",
	"subrarr;": "⥹",
	"succsim;": "≿",
	"supdsub;": "⫘",
	"supedot;": "⫄",
	"suphsol;": "⟉",
	"suphsub;": "⫗",
	"suplarr;": "⥻",
	"supmult;": "⫂",
	"supplus;": "⫀",
	"swarrow;": "↙",
	"topfork;": "⫚",
	"triplus;": "⨹",
	"tritime;": "⨻",
	"UpArrow;": "↑",
	"Uparrow;": "⇑",
	"uparrow;": "↑",
	"Upsilon;": "Υ",
	"upsilon;": "υ",
	"uwangle;": "⦧",
	"vzigzag;": "⦚",
	"zigrarr;": "⇝",
	"andslope;": "⩘",
	"angmsdaa;": "⦨",
	"angmsdab;": "⦩",
	"angmsdac;": "⦪",
	"angmsdad;": "⦫",
	"angmsdae;": "⦬",
	"angmsdaf;": "⦭",
	"angmsdag;": "⦮",
	"angmsdah;": "⦯",
	"angrtvbd;": "⦝",
	"approxeq;": "≊",
	"awconint;": "∳",
	"backcong;": "≌",
	"barwedge;": "⌅",
	"bbrktbrk;": "⎶",
	"bigoplus;": "⨁",
	"bigsqcup;": "⨆",
	"biguplus;": "⨄",
	"bigwedge;": "⋀",
	"boxminus;": "⊟",
	"boxtimes;": "⊠",
	"bsolhsub;": "⟈",
	"capbrcup;": "⩉",
	"circledR;": "®",
	"circledS;": "Ⓢ",
	"cirfnint;": "⨐",
	"clubsuit;": "♣",
	"cupbrcap;": "⩈",
	"curlyvee;": "⋎",
	"cwconint;": "∲",
	"DDotrahd;": "⤑",
	"doteqdot;": "≑",
	"DotEqual;": "≐",
	"dotminus;": "∸",
	"drbkarow;": "⤐",
	"dzigrarr;": "⟿",
	"elinters;": "⏧",
	"emptyset;": "∅",
	"eqvparsl;": "⧥",
	"fpartint;": "⨍",
	"geqslant;": "⩾",
	"gesdotol;": "⪄",
	"gnapprox;": "⪊",
	"hksearow;": "⤥",
	"hkswarow;": "⤦",
	"imagline;": "ℐ",
	"imagpart;": "ℑ",
	"infintie;": "⧝",
	"integers;": "ℤ",
	"Integral;": "∫",
	"intercal;": "⊺",
	"intlarhk;": "⨗",
	"laemptyv;": "⦴",
	"ldrushar;": "⥋",
	"leqslant;": "⩽",
	"lesdotor;": "⪃",
	"LessLess;": "⪡",
	"llcorner;": "⌞",
	"lnapprox;": "⪉",
	"lrcorner;": "⌟",
	"lurdshar;": "⥊",
	"mapstoup;": "↥",
	"multimap;": "⊸",
	"naturals;": "ℕ",
	"ncongdot;": "⩭̸",
	"NotEqual;": "≠",
	"notindot;": "⋵̸",
	"NotTilde;": "≁",
	"otimesas;": "⨶",
	"parallel;": "∥",
	"PartialD;": "∂",
	"plusacir;": "⨣",
	"pointint;": "⨕",
	"Precedes;": "≺",
	"precneqq;": "⪵",
	"precnsim;": "⋨",
	"profalar;": "⌮",
	"profline;": "⌒",
	"profsurf;": "⌓",
	"raemptyv;": "⦳",
	"realpart;": "ℜ",
	"RightTee;": "⊢",
	"rppolint;": "⨒",
	"rtriltri;": "⧎",
	"scpolint;": "⨓",
	"setminus;": "∖",
	"shortmid;": "∣",
	"smeparsl;": "⧤",
	"sqsubset;": "⊏",
	"sqsupset;": "⊐",
	"subseteq;": "⊆",
	"Succeeds;": "≻",
	"succneqq;": "⪶",
	"succnsim;": "⋩",
	"SuchThat;": "∋",
	"Superset;": "⊃",
	"supseteq;": "⊇",
	"thetasym;": "ϑ",
	"thicksim;": "∼",
	"timesbar;": "⨱",
	"triangle;": "▵",
	"triminus;": "⨺",
	"trpezium;": "⏢",
	"Uarrocir;": "⥉",
	"ulcorner;": "⌜",
	"UnderBar;": "_",
	"urcorner;": "⌝",
	"varkappa;": "ϰ",
	"varsigma;": "ς",
	"vartheta;": "ϑ",
	"backprime;": "‵",
	"backsimeq;": "⋍",
	"Backslash;": "∖",
	"bigotimes;": "⨂",
	"CenterDot;": "·",
	"centerdot;": "·",
	"checkmark;": "✓",
	"CircleDot;": "⊙",
	"complexes;": "ℂ",
	"Congruent;": "≡",
	"Coproduct;": "∐",
	"dotsquare;": "⊡",
	"DoubleDot;": "¨",
	"DownArrow;": "↓",
	"Downarrow;": "⇓",
	"downarrow;": "↓",
	"DownBreve;": "̑",
	"gtrapprox;": "⪆",
	"gtreqless;": "⋛",
	"gvertneqq;": "≩︀",
	"heartsuit;": "♥",
	"HumpEqual;": "≏",
	"LeftArrow;": "←",
	"Leftarrow;": "⇐",
	"leftarrow;": "←",
	"LeftFloor;": "⌊",
	"lesseqgtr;": "⋚",
	"LessTilde;": "≲",
	"lvertneqq;": "≨︀",
	"Mellintrf;": "ℳ",
	"MinusPlus;": "∓",
	"ngeqslant;": "⩾̸",
	"nleqslant;": "⩽̸",
	"NotCupCap;": "≭",
	"NotExists;": "∄",
	"NotSubset;": "⊂⃒",
	"nparallel;": "∦",
	"nshortmid;": "∤",
	"nsubseteq;": "⊈",
	"nsupseteq;": "⊉",
	"OverBrace;": "⏞",
	"pitchfork;": "⋔",
	"PlusMinus;": "±",
	"rationals;": "ℚ",
	"spadesuit;": "♠",
	"subseteqq;": "⫅",
	"subsetneq;": "⊊",
	"supseteqq;": "⫆",
	"supsetneq;": "⊋",
	"Therefore;": "∴",
	"therefore;": "∴",
	"ThinSpace;": " ",
	"triangleq;": "≜",
	"TripleDot;": "⃛",
	"UnionPlus;": "⊎",
	"varpropto;": "∝",
	"Bernoullis;": "ℬ",
	"circledast;": "⊛",
	"CirclePlus;": "⊕",
	"complement;": "∁",
	"curlywedge;": "⋏",
	"eqslantgtr;": "⪖",
	"EqualTilde;": "≂",
	"Fouriertrf;": "ℱ",
	"gtreqqless;": "⪌",
	"ImaginaryI;": "ⅈ",
	"Laplacetrf;": "ℒ",
	"LeftVector;": "↼",
	"lessapprox;": "⪅",
	"lesseqqgtr;": "⪋",
	"Lleftarrow;": "⇚",
	"lmoustache;": "⎰",
	"longmapsto;": "⟼",
	"mapstodown;": "↧",
	"mapstoleft;": "↤",
	"nLeftarrow;": "⇍",
	"nleftarrow;": "↚",
	"NotElement;": "∉",
	"NotGreater;": "≯",
	"nsubseteqq;": "⫅̸",
	"nsupseteqq;": "⫆̸",
	"precapprox;": "⪷",
	"Proportion;": "∷",
	"RightArrow;": "→",
	"Rightarrow;": "⇒",
	"rightarrow;": "→",
	"RightFloor;": "⌋",
	"rmoustache;": "⎱",
	"sqsubseteq;": "⊑",
	"sqsupseteq;": "⊒",
	"subsetneqq;": "⫋",
	"succapprox;": "⪸",
	"supsetneqq;": "⫌",
	"ThickSpace;": "  ",
	"TildeEqual;": "≃",
	"TildeTilde;": "≈",
	"UnderBrace;": "⏟",
	"UpArrowBar;": "⤒",
	"UpTeeArrow;": "↥",
	"upuparrows;": "⇈",
	"varepsilon;": "ϵ",
	"varnothing;": "∅",
	"backepsilon;": "϶",
	"blacksquare;": "▪",
	"circledcirc;": "⊚",
	"circleddash;": "⊝",
	"CircleMinus;": "⊖",
	"CircleTimes;": "⊗",
	"curlyeqprec;": "⋞",
	"curlyeqsucc;": "⋟",
	"diamondsuit;": "♦",
	"eqslantless;": "⪕",
	"Equilibrium;": "⇌",
	"expectation;": "ℰ",
	"GreaterLess;": "≷",
	"LeftCeiling;": "⌈",
	"LessGreater;": "≶",
	"MediumSpace;": " ",
	"NotLessLess;": "≪̸",
	"NotPrecedes;": "⊀",
	"NotSucceeds;": "⊁",
	"NotSuperset;": "⊃⃒",
	"nRightarrow;": "⇏",
	"nrightarrow;": "↛",
	"OverBracket;": "⎴",
	"preccurlyeq;": "≼",
	"precnapprox;": "⪹",
	"quaternions;": "ℍ",
	"RightVector;": "⇀",
	"Rrightarrow;": "⇛",
	"RuleDelayed;": "⧴",
	"SmallCircle;": "∘",
	"SquareUnion;": "⊔",
	"straightphi;": "ϕ",
	"SubsetEqual;": "⊆",
	"succcurlyeq;": "≽",
	"succnapprox;": "⪺",
	"thickapprox;": "≈",
	"UpDownArrow;": "↕",
	"Updownarrow;": "⇕",
	"updownarrow;": "↕",
	"VerticalBar;": "∣",
	"blacklozenge;": "⧫",
	"DownArrowBar;": "⤓",
	"DownTeeArrow;": "↧",
	"ExponentialE;": "ⅇ",
	"exponentiale;": "ⅇ",
	"GreaterEqual;": "≥",
	"GreaterTilde;": "≳",
	"HilbertSpace;": "ℋ",
	"HumpDownHump;": "≎",
	"Intersection;": "⋂",
	"LeftArrowBar;": "⇤",
	"LeftTeeArrow;": "↤",
	"LeftTriangle;": "⊲",
	"LeftUpVector;": "↿",
	"NotCongruent;": "≢",
	"NotHumpEqual;": "≏̸",
	"NotLessEqual;": "≰",
	"NotLessTilde;": "≴",
	"Proportional;": "∝",
	"RightCeiling;": "⌉",
	"risingdotseq;": "≓",
	"RoundImplies;": "⥰",
	"ShortUpArrow;": "↑",
	"SquareSubset;": "⊏",
	"triangledown;": "▿",
	"triangleleft;": "◃",
	"UnderBracket;": "⎵",
	"varsubsetneq;": "⊊︀",
	"varsupsetneq;": "⊋︀",
	"VerticalLine;": "|",
	"ApplyFunction;": "⁡",
	"bigtriangleup;": "△",
	"blacktriangle;": "▴",
	"DifferentialD;": "ⅆ",
	"divideontimes;": "⋇",
	"DoubleLeftTee;": "⫤",
	"DoubleUpArrow;": "⇑",
	"fallingdotseq;": "≒",
	"hookleftarrow;": "↩",
	"leftarrowtail;": "↢",
	"leftharpoonup;": "↼",
	"LeftTeeVector;": "⥚",
	"LeftVectorBar;": "⥒",
	"LessFullEqual;": "≦",
	"LongLeftArrow;": "⟵",
	"Longleftarrow;": "⟸",
	"longleftarrow;": "⟵",
	"looparrowleft;": "↫",
	"measuredangle;": "∡",
	"NotEqualTilde;": "≂̸",
	"NotTildeEqual;": "≄",
	"NotTildeTilde;": "≉",
	"ntriangleleft;": "⋪",
	"Poincareplane;": "ℌ",
	"PrecedesEqual;": "⪯",
	"PrecedesTilde;": "≾",
	"RightArrowBar;": "⇥",
	"RightTeeArrow;": "↦",
	"RightTriangle;": "⊳",
	"RightUpVector;": "↾",
	"shortparallel;": "∥",
	"smallsetminus;": "∖",
	"SucceedsEqual;": "⪰",
	"SucceedsTilde;": "≿",
	"SupersetEqual;": "⊇",
	"triangleright;": "▹",
	"UpEquilibrium;": "⥮",
	"upharpoonleft;": "↿",
	"varsubsetneqq;": "⫋︀",
	"varsupsetneqq;": "⫌︀",
	"VerticalTilde;": "≀",
	"VeryThinSpace;": " ",
	"curvearrowleft;": "↶",
	"DiacriticalDot;": "˙",
	"doublebarwedge;": "⌆",
	"DoubleRightTee;": "⊨",
	"downdownarrows;": "⇊",
	"DownLeftVector;": "↽",
	"GreaterGreater;": "⪢",
	"hookrightarrow;": "↪",
	"HorizontalLine;": "─",
	"InvisibleComma;": "⁣",
	"InvisibleTimes;": "⁢",
	"LeftDownVector;": "⇃",
	"leftleftarrows;": "⇇",
	"LeftRightArrow;": "↔",
	"Leftrightarrow;": "⇔",
	"leftrightarrow;": "↔",
	"leftthreetimes;": "⋋",
	"LessSlantEqual;": "⩽",
	"LongRightArrow;": "⟶",
	"Longrightarrow;": "⟹",
	"longrightarrow;": "⟶",
	"looparrowright;": "↬",
	"LowerLeftArrow;": "↙",
	"NestedLessLess;": "≪",
	"NotGreaterLess;": "≹",
	"NotLessGreater;": "≸",
	"NotSubsetEqual;": "⊈",
	"NotVerticalBar;": "∤",
	"nshortparallel;": "∦",
	"ntriangleright;": "⋫",
	"OpenCurlyQuote;": "‘",
	"ReverseElement;": "∋",
	"rightarrowtail;": "↣",
	"rightharpoonup;": "⇀",
	"RightTeeVector;": "⥛",
	"RightVectorBar;": "⥓",
	"ShortDownArrow;": "↓",
	"ShortLeftArrow;": "←",
	"SquareSuperset;": "⊐",
	"TildeFullEqual;": "≅",
	"trianglelefteq;": "⊴",
	"upharpoonright;": "↾",
	"UpperLeftArrow;": "↖",
	"ZeroWidthSpace;": "​",
	"bigtriangledown;": "▽",
	"circlearrowleft;": "↺",
	"CloseCurlyQuote;": "’",
	"ContourIntegral;": "∮",
	"curvearrowright;": "↷",
	"DoubleDownArrow;": "⇓",
	"DoubleLeftArrow;": "⇐",
	"downharpoonleft;": "⇃",
	"DownRightVector;": "⇁",
	"leftharpoondown;": "↽",
	"leftrightarrows;": "⇆",
	"LeftRightVector;": "⥎",
	"LeftTriangleBar;": "⧏",
	"LeftUpTeeVector;": "⥠",
	"LeftUpVectorBar;": "⥘",
	"LowerRightArrow;": "↘",
	"nLeftrightarrow;": "⇎",
	"nleftrightarrow;": "↮",
	"NotGreaterEqual;": "≱",
	"NotGreaterTilde;": "≵",
	"NotHumpDownHump;": "≎̸",
	"NotLeftTriangle;": "⋪",
	"NotSquareSubset;": "⊏̸",
	"ntrianglelefteq;": "⋬",
	"OverParenthesis;": "⏜",
	"RightDownVector;": "⇂",
	"rightleftarrows;": "⇄",
	"rightsquigarrow;": "↝",
	"rightthreetimes;": "⋌",
	"ShortRightArrow;": "→",
	"straightepsilon;": "ϵ",
	"trianglerighteq;": "⊵",
	"UpperRightArrow;": "↗",
	"vartriangleleft;": "⊲",
	"circlearrowright;": "↻",
	"DiacriticalAcute;": "´",
	"DiacriticalGrave;": "`",
	"DiacriticalTilde;": "˜",
	"DoubleRightArrow;": "⇒",
	"DownArrowUpArrow;": "⇵",
	"downharpoonright;": "⇂",
	"EmptySmallSquare;": "◻",
	"GreaterEqualLess;": "⋛",
	"GreaterFullEqual;": "≧",
	"LeftAngleBracket;": "⟨",
	"LeftUpDownVector;": "⥑",
	"LessEqualGreater;": "⋚",
	"NonBreakingSpace;": " ",
	"NotPrecedesEqual;": "⪯̸",
	"NotRightTriangle;": "⋫",
	"NotSucceedsEqual;": "⪰̸",
	"NotSucceedsTilde;": "≿̸",
	"NotSupersetEqual;": "⊉",
	"ntrianglerighteq;": "⋭",
	"rightharpoondown;": "⇁",
	"rightrightarrows;": "⇉",
	"RightTriangleBar;": "⧐",
	"RightUpTeeVector;": "⥜",
	"RightUpVectorBar;": "⥔",
	"twoheadleftarrow;": "↞",
	"UnderParenthesis;": "⏝",
	"UpArrowDownArrow;": "⇅",
	"vartriangleright;": "⊳",
	"blacktriangledown;": "▾",
	"blacktriangleleft;": "◂",
	"DoubleUpDownArrow;": "⇕",
	"DoubleVerticalBar;": "∥",
	"DownLeftTeeVector;": "⥞",
	"DownLeftVectorBar;": "⥖",
	"FilledSmallSquare;": "◼",
	"GreaterSlantEqual;": "⩾",
	"LeftDoubleBracket;": "⟦",
	"LeftDownTeeVector;": "⥡",
	"LeftDownVectorBar;": "⥙",
	"leftrightharpoons;": "⇋",
	"LeftTriangleEqual;": "⊴",
	"NegativeThinSpace;": "​",
	"NotGreaterGreater;": "≫̸",
	"NotLessSlantEqual;": "⩽̸",
	"NotNestedLessLess;": "⪡̸",
	"NotReverseElement;": "∌",
	"NotSquareSuperset;": "⊐̸",
	"NotTildeFullEqual;": "≇",
	"RightAngleBracket;": "⟩",
	"rightleftharpoons;": "⇌",
	"RightUpDownVector;": "⥏",
	"SquareSubsetEqual;": "⊑",
	"twoheadrightarrow;": "↠",
	"VerticalSeparator;": "❘",
	"blacktriangleright;": "▸",
	"DownRightTeeVector;": "⥟",
	"DownRightVectorBar;": "⥗",
	"LongLeftRightArrow;": "⟷",
	"Longleftrightarrow;": "⟺",
	"longleftrightarrow;": "⟷",
	"NegativeThickSpace;": "​",
	"NotLeftTriangleBar;": "⧏̸",
	"PrecedesSlantEqual;": "≼",
	"ReverseEquilibrium;": "⇋",
	"RightDoubleBracket;": "⟧",
	"RightDownTeeVector;": "⥝",
	"RightDownVectorBar;": "⥕",
	"RightTriangleEqual;": "⊵",
	"SquareIntersection;": "⊓",
	"SucceedsSlantEqual;": "≽",
	"DoubleLongLeftArrow;": "⟸",
	"DownLeftRightVector;": "⥐",
	"LeftArrowRightArrow;": "⇆",
	"leftrightsquigarrow;": "↭",
	"NegativeMediumSpace;": "​",
	"NotGreaterFullEqual;": "≧̸",
	"NotRightTriangleBar;": "⧐̸",
	"RightArrowLeftArrow;": "⇄",
	"SquareSupersetEqual;": "⊒",
	"CapitalDifferentialD;": "ⅅ",
	"DoubleLeftRightArrow;": "⇔",
	"DoubleLongRightArrow;": "⟹",
	"EmptyVerySmallSquare;": "▫",
	"NestedGreaterGreater;": "≫",
	"NotDoubleVerticalBar;": "∦",
	"NotGreaterSlantEqual;": "⩾̸",
	"NotLeftTriangleEqual;": "⋬",
	"NotSquareSubsetEqual;": "⋢",
	"OpenCurlyDoubleQuote;": "“",
	"ReverseUpEquilibrium;": "⥯",
	"CloseCurlyDoubleQuote;": "”",
	"DoubleContourIntegral;": "∯",
	"FilledVerySmallSquare;": "▪",
	"NegativeVeryThinSpace;": "​",
	"NotPrecedesSlantEqual;": "⋠",
	"NotRightTriangleEqual;": "⋭",
	"NotSucceedsSlantEqual;": "⋡",
	"DiacriticalDoubleAcute;": "˝",
	"NotSquareSupersetEqual;": "⋣",
	"NotNestedGreaterGreater;": "⪢̸",
	"ClockwiseContourIntegral;": "∲",
	"DoubleLongLeftRightArrow;": "⟺",
	"CounterClockwiseContourIntegral;": "∳"
};

// lazy compute this to make this file tree-shakable for browser
let maxCRNameLength;
const decodeHtml = (rawText, asAttr) => {
    let offset = 0;
    const end = rawText.length;
    let decodedText = '';
    function advance(length) {
        offset += length;
        rawText = rawText.slice(length);
    }
    while (offset < end) {
        const head = /&(?:#x?)?/i.exec(rawText);
        if (!head || offset + head.index >= end) {
            const remaining = end - offset;
            decodedText += rawText.slice(0, remaining);
            advance(remaining);
            break;
        }
        // Advance to the "&".
        decodedText += rawText.slice(0, head.index);
        advance(head.index);
        if (head[0] === '&') {
            // Named character reference.
            let name = '';
            let value = undefined;
            if (/[0-9a-z]/i.test(rawText[1])) {
                if (!maxCRNameLength) {
                    maxCRNameLength = Object.keys(namedCharacterReferences).reduce((max, name) => Math.max(max, name.length), 0);
                }
                for (let length = maxCRNameLength; !value && length > 0; --length) {
                    name = rawText.substr(1, length);
                    value = namedCharacterReferences[name];
                }
                if (value) {
                    const semi = name.endsWith(';');
                    if (asAttr &&
                        !semi &&
                        /[=a-z0-9]/i.test(rawText[name.length + 1] || '')) {
                        decodedText += '&' + name;
                        advance(1 + name.length);
                    }
                    else {
                        decodedText += value;
                        advance(1 + name.length);
                    }
                }
                else {
                    decodedText += '&' + name;
                    advance(1 + name.length);
                }
            }
            else {
                decodedText += '&';
                advance(1);
            }
        }
        else {
            // Numeric character reference.
            const hex = head[0] === '&#x';
            const pattern = hex ? /^&#x([0-9a-f]+);?/i : /^&#([0-9]+);?/;
            const body = pattern.exec(rawText);
            if (!body) {
                decodedText += head[0];
                advance(head[0].length);
            }
            else {
                // https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state
                let cp = Number.parseInt(body[1], hex ? 16 : 10);
                if (cp === 0) {
                    cp = 0xfffd;
                }
                else if (cp > 0x10ffff) {
                    cp = 0xfffd;
                }
                else if (cp >= 0xd800 && cp <= 0xdfff) {
                    cp = 0xfffd;
                }
                else if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) ;
                else if ((cp >= 0x01 && cp <= 0x08) ||
                    cp === 0x0b ||
                    (cp >= 0x0d && cp <= 0x1f) ||
                    (cp >= 0x7f && cp <= 0x9f)) {
                    cp = CCR_REPLACEMENTS[cp] || cp;
                }
                decodedText += String.fromCodePoint(cp);
                advance(body[0].length);
            }
        }
    }
    return decodedText;
};
// https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state
const CCR_REPLACEMENTS = {
    0x80: 0x20ac,
    0x82: 0x201a,
    0x83: 0x0192,
    0x84: 0x201e,
    0x85: 0x2026,
    0x86: 0x2020,
    0x87: 0x2021,
    0x88: 0x02c6,
    0x89: 0x2030,
    0x8a: 0x0160,
    0x8b: 0x2039,
    0x8c: 0x0152,
    0x8e: 0x017d,
    0x91: 0x2018,
    0x92: 0x2019,
    0x93: 0x201c,
    0x94: 0x201d,
    0x95: 0x2022,
    0x96: 0x2013,
    0x97: 0x2014,
    0x98: 0x02dc,
    0x99: 0x2122,
    0x9a: 0x0161,
    0x9b: 0x203a,
    0x9c: 0x0153,
    0x9e: 0x017e,
    0x9f: 0x0178
};

const isRawTextContainer = /*#__PURE__*/ makeMap('style,iframe,script,noscript', true);
const parserOptions = {
    isVoidTag,
    isNativeTag: tag => isHTMLTag(tag) || isSVGTag(tag),
    isPreTag: tag => tag === 'pre',
    decodeEntities: decodeHtml,
    isBuiltInComponent: (tag) => {
        if (isBuiltInType(tag, `Transition`)) {
            return TRANSITION;
        }
        else if (isBuiltInType(tag, `TransitionGroup`)) {
            return TRANSITION_GROUP;
        }
    },
    // https://html.spec.whatwg.org/multipage/parsing.html#tree-construction-dispatcher
    getNamespace(tag, parent) {
        let ns = parent ? parent.ns : 0 /* HTML */;
        if (parent && ns === 2 /* MATH_ML */) {
            if (parent.tag === 'annotation-xml') {
                if (tag === 'svg') {
                    return 1 /* SVG */;
                }
                if (parent.props.some(a => a.type === 6 /* ATTRIBUTE */ &&
                    a.name === 'encoding' &&
                    a.value != null &&
                    (a.value.content === 'text/html' ||
                        a.value.content === 'application/xhtml+xml'))) {
                    ns = 0 /* HTML */;
                }
            }
            else if (/^m(?:[ions]|text)$/.test(parent.tag) &&
                tag !== 'mglyph' &&
                tag !== 'malignmark') {
                ns = 0 /* HTML */;
            }
        }
        else if (parent && ns === 1 /* SVG */) {
            if (parent.tag === 'foreignObject' ||
                parent.tag === 'desc' ||
                parent.tag === 'title') {
                ns = 0 /* HTML */;
            }
        }
        if (ns === 0 /* HTML */) {
            if (tag === 'svg') {
                return 1 /* SVG */;
            }
            if (tag === 'math') {
                return 2 /* MATH_ML */;
            }
        }
        return ns;
    },
    // https://html.spec.whatwg.org/multipage/parsing.html#parsing-html-fragments
    getTextMode({ tag, ns }) {
        if (ns === 0 /* HTML */) {
            if (tag === 'textarea' || tag === 'title') {
                return 1 /* RCDATA */;
            }
            if (isRawTextContainer(tag)) {
                return 2 /* RAWTEXT */;
            }
        }
        return 0 /* DATA */;
    }
};

// Parse inline CSS strings for static style attributes into an object.
// This is a NodeTransform since it works on the static `style` attribute and
// converts it into a dynamic equivalent:
// style="color: red" -> :style='{ "color": "red" }'
// It is then processed by `transformElement` and included in the generated
// props.
const transformStyle = node => {
    if (node.type === 1 /* ELEMENT */) {
        node.props.forEach((p, i) => {
            if (p.type === 6 /* ATTRIBUTE */ && p.name === 'style' && p.value) {
                // replace p with an expression node
                node.props[i] = {
                    type: 7 /* DIRECTIVE */,
                    name: `bind`,
                    arg: createSimpleExpression(`style`, true, p.loc),
                    exp: parseInlineCSS(p.value.content, p.loc),
                    modifiers: [],
                    loc: p.loc
                };
            }
        });
    }
};
const parseInlineCSS = (cssText, loc) => {
    const normalized = parseStringStyle(cssText);
    return createSimpleExpression(JSON.stringify(normalized), false, loc, 3 /* CAN_STRINGIFY */);
};

function createDOMCompilerError(code, loc) {
    return createCompilerError(code, loc, DOMErrorMessages );
}
const DOMErrorMessages = {
    [49 /* X_V_HTML_NO_EXPRESSION */]: `v-html is missing expression.`,
    [50 /* X_V_HTML_WITH_CHILDREN */]: `v-html will override element children.`,
    [51 /* X_V_TEXT_NO_EXPRESSION */]: `v-text is missing expression.`,
    [52 /* X_V_TEXT_WITH_CHILDREN */]: `v-text will override element children.`,
    [53 /* X_V_MODEL_ON_INVALID_ELEMENT */]: `v-model can only be used on <input>, <textarea> and <select> elements.`,
    [54 /* X_V_MODEL_ARG_ON_ELEMENT */]: `v-model argument is not supported on plain elements.`,
    [55 /* X_V_MODEL_ON_FILE_INPUT_ELEMENT */]: `v-model cannot be used on file inputs since they are read-only. Use a v-on:change listener instead.`,
    [56 /* X_V_MODEL_UNNECESSARY_VALUE */]: `Unnecessary value binding used alongside v-model. It will interfere with v-model's behavior.`,
    [57 /* X_V_SHOW_NO_EXPRESSION */]: `v-show is missing expression.`,
    [58 /* X_TRANSITION_INVALID_CHILDREN */]: `<Transition> expects exactly one child element or component.`,
    [59 /* X_IGNORED_SIDE_EFFECT_TAG */]: `Tags with side effect (<script> and <style>) are ignored in client component templates.`
};

const transformVHtml = (dir, node, context) => {
    const { exp, loc } = dir;
    if (!exp) {
        context.onError(createDOMCompilerError(49 /* X_V_HTML_NO_EXPRESSION */, loc));
    }
    if (node.children.length) {
        context.onError(createDOMCompilerError(50 /* X_V_HTML_WITH_CHILDREN */, loc));
        node.children.length = 0;
    }
    return {
        props: [
            createObjectProperty(createSimpleExpression(`innerHTML`, true, loc), exp || createSimpleExpression('', true))
        ]
    };
};

const transformVText = (dir, node, context) => {
    const { exp, loc } = dir;
    if (!exp) {
        context.onError(createDOMCompilerError(51 /* X_V_TEXT_NO_EXPRESSION */, loc));
    }
    if (node.children.length) {
        context.onError(createDOMCompilerError(52 /* X_V_TEXT_WITH_CHILDREN */, loc));
        node.children.length = 0;
    }
    return {
        props: [
            createObjectProperty(createSimpleExpression(`textContent`, true), exp
                ? createCallExpression(context.helperString(TO_DISPLAY_STRING), [exp], loc)
                : createSimpleExpression('', true))
        ]
    };
};

const transformModel$1 = (dir, node, context) => {
    const baseResult = transformModel(dir, node, context);
    // base transform has errors OR component v-model (only need props)
    if (!baseResult.props.length || node.tagType === 1 /* COMPONENT */) {
        return baseResult;
    }
    if (dir.arg) {
        context.onError(createDOMCompilerError(54 /* X_V_MODEL_ARG_ON_ELEMENT */, dir.arg.loc));
    }
    function checkDuplicatedValue() {
        const value = findProp(node, 'value');
        if (value) {
            context.onError(createDOMCompilerError(56 /* X_V_MODEL_UNNECESSARY_VALUE */, value.loc));
        }
    }
    const { tag } = node;
    const isCustomElement = context.isCustomElement(tag);
    if (tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        isCustomElement) {
        let directiveToUse = V_MODEL_TEXT;
        let isInvalidType = false;
        if (tag === 'input' || isCustomElement) {
            const type = findProp(node, `type`);
            if (type) {
                if (type.type === 7 /* DIRECTIVE */) {
                    // :type="foo"
                    directiveToUse = V_MODEL_DYNAMIC;
                }
                else if (type.value) {
                    switch (type.value.content) {
                        case 'radio':
                            directiveToUse = V_MODEL_RADIO;
                            break;
                        case 'checkbox':
                            directiveToUse = V_MODEL_CHECKBOX;
                            break;
                        case 'file':
                            isInvalidType = true;
                            context.onError(createDOMCompilerError(55 /* X_V_MODEL_ON_FILE_INPUT_ELEMENT */, dir.loc));
                            break;
                        default:
                            // text type
                            checkDuplicatedValue();
                            break;
                    }
                }
            }
            else if (hasDynamicKeyVBind(node)) {
                // element has bindings with dynamic keys, which can possibly contain
                // "type".
                directiveToUse = V_MODEL_DYNAMIC;
            }
            else {
                // text type
                checkDuplicatedValue();
            }
        }
        else if (tag === 'select') {
            directiveToUse = V_MODEL_SELECT;
        }
        else {
            // textarea
            checkDuplicatedValue();
        }
        // inject runtime directive
        // by returning the helper symbol via needRuntime
        // the import will replaced a resolveDirective call.
        if (!isInvalidType) {
            baseResult.needRuntime = context.helper(directiveToUse);
        }
    }
    else {
        context.onError(createDOMCompilerError(53 /* X_V_MODEL_ON_INVALID_ELEMENT */, dir.loc));
    }
    // native vmodel doesn't need the `modelValue` props since they are also
    // passed to the runtime as `binding.value`. removing it reduces code size.
    baseResult.props = baseResult.props.filter(p => !(p.key.type === 4 /* SIMPLE_EXPRESSION */ &&
        p.key.content === 'modelValue'));
    return baseResult;
};

const isEventOptionModifier = /*#__PURE__*/ makeMap(`passive,once,capture`);
const isNonKeyModifier = /*#__PURE__*/ makeMap(
// event propagation management
`stop,prevent,self,` +
    // system modifiers + exact
    `ctrl,shift,alt,meta,exact,` +
    // mouse
    `middle`);
// left & right could be mouse or key modifiers based on event type
const maybeKeyModifier = /*#__PURE__*/ makeMap('left,right');
const isKeyboardEvent = /*#__PURE__*/ makeMap(`onkeyup,onkeydown,onkeypress`, true);
const resolveModifiers = (key, modifiers) => {
    const keyModifiers = [];
    const nonKeyModifiers = [];
    const eventOptionModifiers = [];
    for (let i = 0; i < modifiers.length; i++) {
        const modifier = modifiers[i];
        if (isEventOptionModifier(modifier)) {
            // eventOptionModifiers: modifiers for addEventListener() options,
            // e.g. .passive & .capture
            eventOptionModifiers.push(modifier);
        }
        else {
            // runtimeModifiers: modifiers that needs runtime guards
            if (maybeKeyModifier(modifier)) {
                if (isStaticExp(key)) {
                    if (isKeyboardEvent(key.content)) {
                        keyModifiers.push(modifier);
                    }
                    else {
                        nonKeyModifiers.push(modifier);
                    }
                }
                else {
                    keyModifiers.push(modifier);
                    nonKeyModifiers.push(modifier);
                }
            }
            else {
                if (isNonKeyModifier(modifier)) {
                    nonKeyModifiers.push(modifier);
                }
                else {
                    keyModifiers.push(modifier);
                }
            }
        }
    }
    return {
        keyModifiers,
        nonKeyModifiers,
        eventOptionModifiers
    };
};
const transformClick = (key, event) => {
    const isStaticClick = isStaticExp(key) && key.content.toLowerCase() === 'onclick';
    return isStaticClick
        ? createSimpleExpression(event, true)
        : key.type !== 4 /* SIMPLE_EXPRESSION */
            ? createCompoundExpression([
                `(`,
                key,
                `) === "onClick" ? "${event}" : (`,
                key,
                `)`
            ])
            : key;
};
const transformOn$1 = (dir, node, context) => {
    return transformOn(dir, node, context, baseResult => {
        const { modifiers } = dir;
        if (!modifiers.length)
            return baseResult;
        let { key, value: handlerExp } = baseResult.props[0];
        const { keyModifiers, nonKeyModifiers, eventOptionModifiers } = resolveModifiers(key, modifiers);
        // normalize click.right and click.middle since they don't actually fire
        if (nonKeyModifiers.includes('right')) {
            key = transformClick(key, `onContextmenu`);
        }
        if (nonKeyModifiers.includes('middle')) {
            key = transformClick(key, `onMouseup`);
        }
        if (nonKeyModifiers.length) {
            handlerExp = createCallExpression(context.helper(V_ON_WITH_MODIFIERS), [
                handlerExp,
                JSON.stringify(nonKeyModifiers)
            ]);
        }
        if (keyModifiers.length &&
            // if event name is dynamic, always wrap with keys guard
            (!isStaticExp(key) || isKeyboardEvent(key.content))) {
            handlerExp = createCallExpression(context.helper(V_ON_WITH_KEYS), [
                handlerExp,
                JSON.stringify(keyModifiers)
            ]);
        }
        if (eventOptionModifiers.length) {
            const modifierPostfix = eventOptionModifiers.map(capitalize).join('');
            key = isStaticExp(key)
                ? createSimpleExpression(`${key.content}${modifierPostfix}`, true)
                : createCompoundExpression([`(`, key, `) + "${modifierPostfix}"`]);
        }
        return {
            props: [createObjectProperty(key, handlerExp)]
        };
    });
};

const transformShow = (dir, node, context) => {
    const { exp, loc } = dir;
    if (!exp) {
        context.onError(createDOMCompilerError(57 /* X_V_SHOW_NO_EXPRESSION */, loc));
    }
    return {
        props: [],
        needRuntime: context.helper(V_SHOW)
    };
};

const warnTransitionChildren = (node, context) => {
    if (node.type === 1 /* ELEMENT */ &&
        node.tagType === 1 /* COMPONENT */) {
        const component = context.isBuiltInComponent(node.tag);
        if (component === TRANSITION) {
            return () => {
                if (node.children.length && hasMultipleChildren(node)) {
                    context.onError(createDOMCompilerError(58 /* X_TRANSITION_INVALID_CHILDREN */, {
                        start: node.children[0].loc.start,
                        end: node.children[node.children.length - 1].loc.end,
                        source: ''
                    }));
                }
            };
        }
    }
};
function hasMultipleChildren(node) {
    // #1352 filter out potential comment nodes.
    const children = (node.children = node.children.filter(c => c.type !== 3 /* COMMENT */));
    const child = children[0];
    return (children.length !== 1 ||
        child.type === 11 /* FOR */ ||
        (child.type === 9 /* IF */ && child.branches.some(hasMultipleChildren)));
}

/**
 * This module is Node-only.
 */
/**
 * Turn eligible hoisted static trees into stringified static nodes, e.g.
 *
 * ```js
 * const _hoisted_1 = createStaticVNode(`<div class="foo">bar</div>`)
 * ```
 *
 * A single static vnode can contain stringified content for **multiple**
 * consecutive nodes (element and plain text), called a "chunk".
 * `@vue/runtime-dom` will create the content via innerHTML in a hidden
 * container element and insert all the nodes in place. The call must also
 * provide the number of nodes contained in the chunk so that during hydration
 * we can know how many nodes the static vnode should adopt.
 *
 * The optimization scans a children list that contains hoisted nodes, and
 * tries to find the largest chunk of consecutive hoisted nodes before running
 * into a non-hoisted node or the end of the list. A chunk is then converted
 * into a single static vnode and replaces the hoisted expression of the first
 * node in the chunk. Other nodes in the chunk are considered "merged" and
 * therefore removed from both the hoist list and the children array.
 *
 * This optimization is only performed in Node.js.
 */
const stringifyStatic = (children, context, parent) => {
    // bail stringification for slot content
    if (context.scopes.vSlot > 0) {
        return;
    }
    let nc = 0; // current node count
    let ec = 0; // current element with binding count
    const currentChunk = [];
    const stringifyCurrentChunk = (currentIndex) => {
        if (nc >= 20 /* NODE_COUNT */ ||
            ec >= 5 /* ELEMENT_WITH_BINDING_COUNT */) {
            // combine all currently eligible nodes into a single static vnode call
            const staticCall = createCallExpression(context.helper(CREATE_STATIC), [
                JSON.stringify(currentChunk.map(node => stringifyNode(node, context)).join('')),
                // the 2nd argument indicates the number of DOM nodes this static vnode
                // will insert / hydrate
                String(currentChunk.length)
            ]);
            // replace the first node's hoisted expression with the static vnode call
            replaceHoist(currentChunk[0], staticCall, context);
            if (currentChunk.length > 1) {
                for (let i = 1; i < currentChunk.length; i++) {
                    // for the merged nodes, set their hoisted expression to null
                    replaceHoist(currentChunk[i], null, context);
                }
                // also remove merged nodes from children
                const deleteCount = currentChunk.length - 1;
                children.splice(currentIndex - currentChunk.length + 1, deleteCount);
                return deleteCount;
            }
        }
        return 0;
    };
    let i = 0;
    for (; i < children.length; i++) {
        const child = children[i];
        const hoisted = getHoistedNode(child);
        if (hoisted) {
            // presence of hoisted means child must be a stringifiable node
            const node = child;
            const result = analyzeNode(node);
            if (result) {
                // node is stringifiable, record state
                nc += result[0];
                ec += result[1];
                currentChunk.push(node);
                continue;
            }
        }
        // we only reach here if we ran into a node that is not stringifiable
        // check if currently analyzed nodes meet criteria for stringification.
        // adjust iteration index
        i -= stringifyCurrentChunk(i);
        // reset state
        nc = 0;
        ec = 0;
        currentChunk.length = 0;
    }
    // in case the last node was also stringifiable
    stringifyCurrentChunk(i);
};
const getHoistedNode = (node) => ((node.type === 1 /* ELEMENT */ && node.tagType === 0 /* ELEMENT */) ||
    node.type == 12 /* TEXT_CALL */) &&
    node.codegenNode &&
    node.codegenNode.type === 4 /* SIMPLE_EXPRESSION */ &&
    node.codegenNode.hoisted;
const dataAriaRE = /^(data|aria)-/;
const isStringifiableAttr = (name) => {
    return isKnownAttr(name) || dataAriaRE.test(name);
};
const replaceHoist = (node, replacement, context) => {
    const hoistToReplace = node.codegenNode.hoisted;
    context.hoists[context.hoists.indexOf(hoistToReplace)] = replacement;
};
const isNonStringifiable = /*#__PURE__*/ makeMap(`caption,thead,tr,th,tbody,td,tfoot,colgroup,col`);
/**
 * for a hoisted node, analyze it and return:
 * - false: bailed (contains runtime constant)
 * - [nc, ec] where
 *   - nc is the number of nodes inside
 *   - ec is the number of element with bindings inside
 */
function analyzeNode(node) {
    if (node.type === 1 /* ELEMENT */ && isNonStringifiable(node.tag)) {
        return false;
    }
    if (node.type === 12 /* TEXT_CALL */) {
        return [1, 0];
    }
    let nc = 1; // node count
    let ec = node.props.length > 0 ? 1 : 0; // element w/ binding count
    let bailed = false;
    const bail = () => {
        bailed = true;
        return false;
    };
    // TODO: check for cases where using innerHTML will result in different
    // output compared to imperative node insertions.
    // probably only need to check for most common case
    // i.e. non-phrasing-content tags inside `<p>`
    function walk(node) {
        for (let i = 0; i < node.props.length; i++) {
            const p = node.props[i];
            // bail on non-attr bindings
            if (p.type === 6 /* ATTRIBUTE */ && !isStringifiableAttr(p.name)) {
                return bail();
            }
            if (p.type === 7 /* DIRECTIVE */ && p.name === 'bind') {
                // bail on non-attr bindings
                if (p.arg &&
                    (p.arg.type === 8 /* COMPOUND_EXPRESSION */ ||
                        (p.arg.isStatic && !isStringifiableAttr(p.arg.content)))) {
                    return bail();
                }
            }
        }
        for (let i = 0; i < node.children.length; i++) {
            nc++;
            const child = node.children[i];
            if (child.type === 1 /* ELEMENT */) {
                if (child.props.length > 0) {
                    ec++;
                }
                walk(child);
                if (bailed) {
                    return false;
                }
            }
        }
        return true;
    }
    return walk(node) ? [nc, ec] : false;
}
function stringifyNode(node, context) {
    if (isString(node)) {
        return node;
    }
    if (isSymbol(node)) {
        return ``;
    }
    switch (node.type) {
        case 1 /* ELEMENT */:
            return stringifyElement(node, context);
        case 2 /* TEXT */:
            return escapeHtml(node.content);
        case 3 /* COMMENT */:
            return `<!--${escapeHtml(node.content)}-->`;
        case 5 /* INTERPOLATION */:
            return escapeHtml(toDisplayString(evaluateConstant(node.content)));
        case 8 /* COMPOUND_EXPRESSION */:
            return escapeHtml(evaluateConstant(node));
        case 12 /* TEXT_CALL */:
            return stringifyNode(node.content, context);
        default:
            // static trees will not contain if/for nodes
            return '';
    }
}
function stringifyElement(node, context) {
    let res = `<${node.tag}`;
    for (let i = 0; i < node.props.length; i++) {
        const p = node.props[i];
        if (p.type === 6 /* ATTRIBUTE */) {
            res += ` ${p.name}`;
            if (p.value) {
                res += `="${escapeHtml(p.value.content)}"`;
            }
        }
        else if (p.type === 7 /* DIRECTIVE */ && p.name === 'bind') {
            // constant v-bind, e.g. :foo="1"
            let evaluated = evaluateConstant(p.exp);
            if (evaluated != null) {
                const arg = p.arg && p.arg.content;
                if (arg === 'class') {
                    evaluated = normalizeClass(evaluated);
                }
                else if (arg === 'style') {
                    evaluated = stringifyStyle(normalizeStyle(evaluated));
                }
                res += ` ${p.arg.content}="${escapeHtml(evaluated)}"`;
            }
        }
    }
    if (context.scopeId) {
        res += ` ${context.scopeId}`;
    }
    res += `>`;
    for (let i = 0; i < node.children.length; i++) {
        res += stringifyNode(node.children[i], context);
    }
    if (!isVoidTag(node.tag)) {
        res += `</${node.tag}>`;
    }
    return res;
}
// __UNSAFE__
// Reason: eval.
// It's technically safe to eval because only constant expressions are possible
// here, e.g. `{{ 1 }}` or `{{ 'foo' }}`
// in addition, constant exps bail on presence of parens so you can't even
// run JSFuck in here. But we mark it unsafe for security review purposes.
// (see compiler-core/src/transformExpressions)
function evaluateConstant(exp) {
    if (exp.type === 4 /* SIMPLE_EXPRESSION */) {
        return new Function(`return ${exp.content}`)();
    }
    else {
        // compound
        let res = ``;
        exp.children.forEach(c => {
            if (isString(c) || isSymbol(c)) {
                return;
            }
            if (c.type === 2 /* TEXT */) {
                res += c.content;
            }
            else if (c.type === 5 /* INTERPOLATION */) {
                res += toDisplayString(evaluateConstant(c.content));
            }
            else {
                res += evaluateConstant(c);
            }
        });
        return res;
    }
}

const ignoreSideEffectTags = (node, context) => {
    if (node.type === 1 /* ELEMENT */ &&
        node.tagType === 0 /* ELEMENT */ &&
        (node.tag === 'script' || node.tag === 'style')) {
        context.onError(createDOMCompilerError(59 /* X_IGNORED_SIDE_EFFECT_TAG */, node.loc));
        context.removeNode();
    }
};

const DOMNodeTransforms = [
    transformStyle,
    ...([warnTransitionChildren] )
];
const DOMDirectiveTransforms = {
    cloak: noopDirectiveTransform,
    html: transformVHtml,
    text: transformVText,
    model: transformModel$1,
    on: transformOn$1,
    show: transformShow
};
function compile(template, options = {}) {
    return baseCompile(template, extend({}, parserOptions, options, {
        nodeTransforms: [
            // ignore <script> and <tag>
            // this is not put inside DOMNodeTransforms because that list is used
            // by compiler-ssr to generate vnode fallback branches
            ignoreSideEffectTags,
            ...DOMNodeTransforms,
            ...(options.nodeTransforms || [])
        ],
        directiveTransforms: extend({}, DOMDirectiveTransforms, options.directiveTransforms || {}),
        transformHoist: stringifyStatic
    }));
}

const SSR_INTERPOLATE = Symbol(`ssrInterpolate`);
const SSR_RENDER_VNODE = Symbol(`ssrRenderVNode`);
const SSR_RENDER_COMPONENT = Symbol(`ssrRenderComponent`);
const SSR_RENDER_SLOT = Symbol(`ssrRenderSlot`);
const SSR_RENDER_CLASS = Symbol(`ssrRenderClass`);
const SSR_RENDER_STYLE = Symbol(`ssrRenderStyle`);
const SSR_RENDER_ATTRS = Symbol(`ssrRenderAttrs`);
const SSR_RENDER_ATTR = Symbol(`ssrRenderAttr`);
const SSR_RENDER_DYNAMIC_ATTR = Symbol(`ssrRenderDynamicAttr`);
const SSR_RENDER_LIST = Symbol(`ssrRenderList`);
const SSR_LOOSE_EQUAL = Symbol(`ssrLooseEqual`);
const SSR_LOOSE_CONTAIN = Symbol(`ssrLooseContain`);
const SSR_RENDER_DYNAMIC_MODEL = Symbol(`ssrRenderDynamicModel`);
const SSR_GET_DYNAMIC_MODEL_PROPS = Symbol(`ssrGetDynamicModelProps`);
const SSR_RENDER_TELEPORT = Symbol(`ssrRenderTeleport`);
const SSR_RENDER_SUSPENSE = Symbol(`ssrRenderSuspense`);
const ssrHelpers = {
    [SSR_INTERPOLATE]: `ssrInterpolate`,
    [SSR_RENDER_VNODE]: `ssrRenderVNode`,
    [SSR_RENDER_COMPONENT]: `ssrRenderComponent`,
    [SSR_RENDER_SLOT]: `ssrRenderSlot`,
    [SSR_RENDER_CLASS]: `ssrRenderClass`,
    [SSR_RENDER_STYLE]: `ssrRenderStyle`,
    [SSR_RENDER_ATTRS]: `ssrRenderAttrs`,
    [SSR_RENDER_ATTR]: `ssrRenderAttr`,
    [SSR_RENDER_DYNAMIC_ATTR]: `ssrRenderDynamicAttr`,
    [SSR_RENDER_LIST]: `ssrRenderList`,
    [SSR_LOOSE_EQUAL]: `ssrLooseEqual`,
    [SSR_LOOSE_CONTAIN]: `ssrLooseContain`,
    [SSR_RENDER_DYNAMIC_MODEL]: `ssrRenderDynamicModel`,
    [SSR_GET_DYNAMIC_MODEL_PROPS]: `ssrGetDynamicModelProps`,
    [SSR_RENDER_TELEPORT]: `ssrRenderTeleport`,
    [SSR_RENDER_SUSPENSE]: `ssrRenderSuspense`
};
// Note: these are helpers imported from @vue/server-renderer
// make sure the names match!
registerRuntimeHelpers(ssrHelpers);

// Plugin for the first transform pass, which simply constructs the AST node
const ssrTransformIf = createStructuralDirectiveTransform(/^(if|else|else-if)$/, processIf);
// This is called during the 2nd transform pass to construct the SSR-specific
// codegen nodes.
function ssrProcessIf(node, context, disableNestedFragments = false) {
    const [rootBranch] = node.branches;
    const ifStatement = createIfStatement(rootBranch.condition, processIfBranch(rootBranch, context, disableNestedFragments));
    context.pushStatement(ifStatement);
    let currentIf = ifStatement;
    for (let i = 1; i < node.branches.length; i++) {
        const branch = node.branches[i];
        const branchBlockStatement = processIfBranch(branch, context, disableNestedFragments);
        if (branch.condition) {
            // else-if
            currentIf = currentIf.alternate = createIfStatement(branch.condition, branchBlockStatement);
        }
        else {
            // else
            currentIf.alternate = branchBlockStatement;
        }
    }
    if (!currentIf.alternate) {
        currentIf.alternate = createBlockStatement([
            createCallExpression(`_push`, ['`<!---->`'])
        ]);
    }
}
function processIfBranch(branch, context, disableNestedFragments = false) {
    const { children } = branch;
    const needFragmentWrapper = !disableNestedFragments &&
        (children.length !== 1 || children[0].type !== 1 /* ELEMENT */) &&
        // optimize away nested fragments when the only child is a ForNode
        !(children.length === 1 && children[0].type === 11 /* FOR */);
    return processChildrenAsStatement(children, context, needFragmentWrapper);
}

// Plugin for the first transform pass, which simply constructs the AST node
const ssrTransformFor = createStructuralDirectiveTransform('for', processFor);
// This is called during the 2nd transform pass to construct the SSR-specific
// codegen nodes.
function ssrProcessFor(node, context, disableNestedFragments = false) {
    const needFragmentWrapper = !disableNestedFragments &&
        (node.children.length !== 1 || node.children[0].type !== 1 /* ELEMENT */);
    const renderLoop = createFunctionExpression(createForLoopParams(node.parseResult));
    renderLoop.body = processChildrenAsStatement(node.children, context, needFragmentWrapper);
    // v-for always renders a fragment unless explicitly disabled
    if (!disableNestedFragments) {
        context.pushStringPart(`<!--[-->`);
    }
    context.pushStatement(createCallExpression(context.helper(SSR_RENDER_LIST), [
        node.source,
        renderLoop
    ]));
    if (!disableNestedFragments) {
        context.pushStringPart(`<!--]-->`);
    }
}

const ssrTransformSlotOutlet = (node, context) => {
    if (isSlotOutlet(node)) {
        const { slotName, slotProps } = processSlotOutlet(node, context);
        const args = [
            `_ctx.$slots`,
            slotName,
            slotProps || `{}`,
            // fallback content placeholder. will be replaced in the process phase
            `null`,
            `_push`,
            `_parent`
        ];
        // inject slot scope id if current template uses :slotted
        if (context.scopeId && context.slotted !== false) {
            args.push(`"${context.scopeId}-s"`);
        }
        node.ssrCodegenNode = createCallExpression(context.helper(SSR_RENDER_SLOT), args);
    }
};
function ssrProcessSlotOutlet(node, context) {
    const renderCall = node.ssrCodegenNode;
    // has fallback content
    if (node.children.length) {
        const fallbackRenderFn = createFunctionExpression([]);
        fallbackRenderFn.body = processChildrenAsStatement(node.children, context);
        // _renderSlot(slots, name, props, fallback, ...)
        renderCall.arguments[3] = fallbackRenderFn;
    }
    // Forwarded <slot/>. Merge slot scope ids
    if (context.withSlotScopeId) {
        const slotScopeId = renderCall.arguments[6];
        renderCall.arguments[6] = slotScopeId
            ? `${slotScopeId} + _scopeId`
            : `_scopeId`;
    }
    context.pushStatement(node.ssrCodegenNode);
}

function createSSRCompilerError(code, loc) {
    return createCompilerError(code, loc, SSRErrorMessages);
}
const SSRErrorMessages = {
    [60 /* X_SSR_CUSTOM_DIRECTIVE_NO_TRANSFORM */]: `Custom directive is missing corresponding SSR transform and will be ignored.`,
    [61 /* X_SSR_UNSAFE_ATTR_NAME */]: `Unsafe attribute name for SSR.`,
    [62 /* X_SSR_NO_TELEPORT_TARGET */]: `Missing the 'to' prop on teleport element.`,
    [63 /* X_SSR_INVALID_AST_NODE */]: `Invalid AST node during SSR transform.`
};

// Note: this is a 2nd-pass codegen transform.
function ssrProcessTeleport(node, context) {
    const targetProp = findProp(node, 'to');
    if (!targetProp) {
        context.onError(createSSRCompilerError(62 /* X_SSR_NO_TELEPORT_TARGET */, node.loc));
        return;
    }
    let target;
    if (targetProp.type === 6 /* ATTRIBUTE */) {
        target =
            targetProp.value && createSimpleExpression(targetProp.value.content, true);
    }
    else {
        target = targetProp.exp;
    }
    if (!target) {
        context.onError(createSSRCompilerError(62 /* X_SSR_NO_TELEPORT_TARGET */, targetProp.loc));
        return;
    }
    const disabledProp = findProp(node, 'disabled', false, true /* allow empty */);
    const disabled = disabledProp
        ? disabledProp.type === 6 /* ATTRIBUTE */
            ? `true`
            : disabledProp.exp || `false`
        : `false`;
    const contentRenderFn = createFunctionExpression([`_push`], undefined, // Body is added later
    true, // newline
    false, // isSlot
    node.loc);
    contentRenderFn.body = processChildrenAsStatement(node.children, context);
    context.pushStatement(createCallExpression(context.helper(SSR_RENDER_TELEPORT), [
        `_push`,
        contentRenderFn,
        target,
        disabled,
        `_parent`
    ]));
}

const wipMap = new WeakMap();
// phase 1
function ssrTransformSuspense(node, context) {
    return () => {
        if (node.children.length) {
            const wipEntry = {
                slotsExp: null,
                wipSlots: []
            };
            wipMap.set(node, wipEntry);
            wipEntry.slotsExp = buildSlots(node, context, (_props, children, loc) => {
                const fn = createFunctionExpression([], undefined, // no return, assign body later
                true, // newline
                false, // suspense slots are not treated as normal slots
                loc);
                wipEntry.wipSlots.push({
                    fn,
                    children
                });
                return fn;
            }).slots;
        }
    };
}
// phase 2
function ssrProcessSuspense(node, context) {
    // complete wip slots with ssr code
    const wipEntry = wipMap.get(node);
    if (!wipEntry) {
        return;
    }
    const { slotsExp, wipSlots } = wipEntry;
    for (let i = 0; i < wipSlots.length; i++) {
        const { fn, children } = wipSlots[i];
        fn.body = processChildrenAsStatement(children, context);
    }
    // _push(ssrRenderSuspense(slots))
    context.pushStatement(createCallExpression(context.helper(SSR_RENDER_SUSPENSE), [
        `_push`,
        slotsExp
    ]));
}

function ssrProcessTransitionGroup(node, context) {
    const tag = findProp(node, 'tag');
    if (tag) {
        if (tag.type === 7 /* DIRECTIVE */) {
            // dynamic :tag
            context.pushStringPart(`<`);
            context.pushStringPart(tag.exp);
            context.pushStringPart(`>`);
            processChildren(node.children, context, false, 
            /**
             * TransitionGroup has the special runtime behavior of flattening and
             * concatenating all children into a single fragment (in order for them to
             * be pathced using the same key map) so we need to account for that here
             * by disabling nested fragment wrappers from being generated.
             */
            true);
            context.pushStringPart(`</`);
            context.pushStringPart(tag.exp);
            context.pushStringPart(`>`);
        }
        else {
            // static tag
            context.pushStringPart(`<${tag.value.content}>`);
            processChildren(node.children, context, false, true);
            context.pushStringPart(`</${tag.value.content}>`);
        }
    }
    else {
        // fragment
        processChildren(node.children, context, true, true);
    }
}

// We need to construct the slot functions in the 1st pass to ensure proper
// scope tracking, but the children of each slot cannot be processed until
// the 2nd pass, so we store the WIP slot functions in a weakmap during the 1st
// pass and complete them in the 2nd pass.
const wipMap$1 = new WeakMap();
const componentTypeMap = new WeakMap();
// ssr component transform is done in two phases:
// In phase 1. we use `buildSlot` to analyze the children of the component into
// WIP slot functions (it must be done in phase 1 because `buildSlot` relies on
// the core transform context).
// In phase 2. we convert the WIP slots from phase 1 into ssr-specific codegen
// nodes.
const ssrTransformComponent = (node, context) => {
    if (node.type !== 1 /* ELEMENT */ ||
        node.tagType !== 1 /* COMPONENT */) {
        return;
    }
    const component = resolveComponentType(node, context, true /* ssr */);
    componentTypeMap.set(node, component);
    if (isSymbol(component)) {
        if (component === SUSPENSE) {
            return ssrTransformSuspense(node, context);
        }
        return; // built-in component: fallthrough
    }
    // Build the fallback vnode-based branch for the component's slots.
    // We need to clone the node into a fresh copy and use the buildSlots' logic
    // to get access to the children of each slot. We then compile them with
    // a child transform pipeline using vnode-based transforms (instead of ssr-
    // based ones), and save the result branch (a ReturnStatement) in an array.
    // The branch is retrieved when processing slots again in ssr mode.
    const vnodeBranches = [];
    const clonedNode = clone(node);
    return function ssrPostTransformComponent() {
        // Using the cloned node, build the normal VNode-based branches (for
        // fallback in case the child is render-fn based). Store them in an array
        // for later use.
        if (clonedNode.children.length) {
            buildSlots(clonedNode, context, (props, children) => {
                vnodeBranches.push(createVNodeSlotBranch(props, children, context));
                return createFunctionExpression(undefined);
            });
        }
        const props = node.props.length > 0
            ? // note we are not passing ssr: true here because for components, v-on
                // handlers should still be passed
                buildProps(node, context).props || `null`
            : `null`;
        const wipEntries = [];
        wipMap$1.set(node, wipEntries);
        const buildSSRSlotFn = (props, children, loc) => {
            const fn = createFunctionExpression([props || `_`, `_push`, `_parent`, `_scopeId`], undefined, // no return, assign body later
            true, // newline
            true, // isSlot
            loc);
            wipEntries.push({
                fn,
                children,
                // also collect the corresponding vnode branch built earlier
                vnodeBranch: vnodeBranches[wipEntries.length]
            });
            return fn;
        };
        const slots = node.children.length
            ? buildSlots(node, context, buildSSRSlotFn).slots
            : `null`;
        if (typeof component !== 'string') {
            // dynamic component that resolved to a `resolveDynamicComponent` call
            // expression - since the resolved result may be a plain element (string)
            // or a VNode, handle it with `renderVNode`.
            node.ssrCodegenNode = createCallExpression(context.helper(SSR_RENDER_VNODE), [
                `_push`,
                createCallExpression(context.helper(CREATE_VNODE), [
                    component,
                    props,
                    slots
                ]),
                `_parent`
            ]);
        }
        else {
            node.ssrCodegenNode = createCallExpression(context.helper(SSR_RENDER_COMPONENT), [component, props, slots, `_parent`]);
        }
    };
};
function ssrProcessComponent(node, context) {
    const component = componentTypeMap.get(node);
    if (!node.ssrCodegenNode) {
        // this is a built-in component that fell-through.
        if (component === TELEPORT) {
            return ssrProcessTeleport(node, context);
        }
        else if (component === SUSPENSE) {
            return ssrProcessSuspense(node, context);
        }
        else if (component === TRANSITION_GROUP) {
            return ssrProcessTransitionGroup(node, context);
        }
        else {
            // real fall-through (e.g. KeepAlive): just render its children.
            processChildren(node.children, context);
        }
    }
    else {
        // finish up slot function expressions from the 1st pass.
        const wipEntries = wipMap$1.get(node) || [];
        for (let i = 0; i < wipEntries.length; i++) {
            const { fn, children, vnodeBranch } = wipEntries[i];
            // For each slot, we generate two branches: one SSR-optimized branch and
            // one normal vnode-based branch. The branches are taken based on the
            // presence of the 2nd `_push` argument (which is only present if the slot
            // is called by `_ssrRenderSlot`.
            fn.body = createIfStatement(createSimpleExpression(`_push`, false), processChildrenAsStatement(children, context, false, true /* withSlotScopeId */), vnodeBranch);
        }
        // component is inside a slot, inherit slot scope Id
        if (context.withSlotScopeId) {
            node.ssrCodegenNode.arguments.push(`_scopeId`);
        }
        if (typeof component === 'string') {
            // static component
            context.pushStatement(createCallExpression(`_push`, [node.ssrCodegenNode]));
        }
        else {
            // dynamic component (`resolveDynamicComponent` call)
            // the codegen node is a `renderVNode` call
            context.pushStatement(node.ssrCodegenNode);
        }
    }
}
const rawOptionsMap = new WeakMap();
const [baseNodeTransforms, baseDirectiveTransforms] = getBaseTransformPreset(true);
const vnodeNodeTransforms = [...baseNodeTransforms, ...DOMNodeTransforms];
const vnodeDirectiveTransforms = {
    ...baseDirectiveTransforms,
    ...DOMDirectiveTransforms
};
function createVNodeSlotBranch(props, children, parentContext) {
    // apply a sub-transform using vnode-based transforms.
    const rawOptions = rawOptionsMap.get(parentContext.root);
    const subOptions = {
        ...rawOptions,
        // overwrite with vnode-based transforms
        nodeTransforms: [
            ...vnodeNodeTransforms,
            ...(rawOptions.nodeTransforms || [])
        ],
        directiveTransforms: {
            ...vnodeDirectiveTransforms,
            ...(rawOptions.directiveTransforms || {})
        }
    };
    // wrap the children with a wrapper template for proper children treatment.
    const wrapperNode = {
        type: 1 /* ELEMENT */,
        ns: 0 /* HTML */,
        tag: 'template',
        tagType: 3 /* TEMPLATE */,
        isSelfClosing: false,
        // important: provide v-slot="props" on the wrapper for proper
        // scope analysis
        props: [
            {
                type: 7 /* DIRECTIVE */,
                name: 'slot',
                exp: props,
                arg: undefined,
                modifiers: [],
                loc: locStub
            }
        ],
        children,
        loc: locStub,
        codegenNode: undefined
    };
    subTransform(wrapperNode, subOptions, parentContext);
    return createReturnStatement(children);
}
function subTransform(node, options, parentContext) {
    const childRoot = createRoot([node]);
    const childContext = createTransformContext(childRoot, options);
    // this sub transform is for vnode fallback branch so it should be handled
    // like normal render functions
    childContext.ssr = false;
    // inherit parent scope analysis state
    childContext.scopes = { ...parentContext.scopes };
    childContext.identifiers = { ...parentContext.identifiers };
    childContext.imports = parentContext.imports;
    // traverse
    traverseNode(childRoot, childContext);
    ['helpers', 'components', 'directives'].forEach(key => {
        childContext[key].forEach((value, helperKey) => {
            if (key === 'helpers') {
                const parentCount = parentContext.helpers.get(helperKey);
                if (parentCount === undefined) {
                    parentContext.helpers.set(helperKey, value);
                }
                else {
                    parentContext.helpers.set(helperKey, value + parentCount);
                }
            }
            else {
                parentContext[key].add(value);
            }
        });
    });
    // imports/hoists are not merged because:
    // - imports are only used for asset urls and should be consistent between
    //   node/client branches
    // - hoists are not enabled for the client branch here
}
function clone(v) {
    if (isArray(v)) {
        return v.map(clone);
    }
    else if (isObject(v)) {
        const res = {};
        for (const key in v) {
            res[key] = clone(v[key]);
        }
        return res;
    }
    else {
        return v;
    }
}

// for directives with children overwrite (e.g. v-html & v-text), we need to
// store the raw children so that they can be added in the 2nd pass.
const rawChildrenMap = new WeakMap();
const ssrTransformElement = (node, context) => {
    if (node.type !== 1 /* ELEMENT */ ||
        node.tagType !== 0 /* ELEMENT */) {
        return;
    }
    return function ssrPostTransformElement() {
        // element
        // generate the template literal representing the open tag.
        const openTag = [`<${node.tag}`];
        // some tags need to be passed to runtime for special checks
        const needTagForRuntime = node.tag === 'textarea' || node.tag.indexOf('-') > 0;
        // v-bind="obj" or v-bind:[key] can potentially overwrite other static
        // attrs and can affect final rendering result, so when they are present
        // we need to bail out to full `renderAttrs`
        const hasDynamicVBind = hasDynamicKeyVBind(node);
        if (hasDynamicVBind) {
            const { props } = buildProps(node, context, node.props, true /* ssr */);
            if (props) {
                const propsExp = createCallExpression(context.helper(SSR_RENDER_ATTRS), [props]);
                if (node.tag === 'textarea') {
                    const existingText = node.children[0];
                    // If interpolation, this is dynamic <textarea> content, potentially
                    // injected by v-model and takes higher priority than v-bind value
                    if (!existingText || existingText.type !== 5 /* INTERPOLATION */) {
                        // <textarea> with dynamic v-bind. We don't know if the final props
                        // will contain .value, so we will have to do something special:
                        // assign the merged props to a temp variable, and check whether
                        // it contains value (if yes, render is as children).
                        const tempId = `_temp${context.temps++}`;
                        propsExp.arguments = [
                            createAssignmentExpression(createSimpleExpression(tempId, false), props)
                        ];
                        rawChildrenMap.set(node, createCallExpression(context.helper(SSR_INTERPOLATE), [
                            createConditionalExpression(createSimpleExpression(`"value" in ${tempId}`, false), createSimpleExpression(`${tempId}.value`, false), createSimpleExpression(existingText ? existingText.content : ``, true), false)
                        ]));
                    }
                }
                else if (node.tag === 'input') {
                    // <input v-bind="obj" v-model>
                    // we need to determine the props to render for the dynamic v-model
                    // and merge it with the v-bind expression.
                    const vModel = findVModel(node);
                    if (vModel) {
                        // 1. save the props (san v-model) in a temp variable
                        const tempId = `_temp${context.temps++}`;
                        const tempExp = createSimpleExpression(tempId, false);
                        propsExp.arguments = [
                            createSequenceExpression([
                                createAssignmentExpression(tempExp, props),
                                createCallExpression(context.helper(MERGE_PROPS), [
                                    tempExp,
                                    createCallExpression(context.helper(SSR_GET_DYNAMIC_MODEL_PROPS), [
                                        tempExp,
                                        vModel.exp // model
                                    ])
                                ])
                            ])
                        ];
                    }
                }
                if (needTagForRuntime) {
                    propsExp.arguments.push(`"${node.tag}"`);
                }
                openTag.push(propsExp);
            }
        }
        // book keeping static/dynamic class merging.
        let dynamicClassBinding = undefined;
        let staticClassBinding = undefined;
        // all style bindings are converted to dynamic by transformStyle.
        // but we need to make sure to merge them.
        let dynamicStyleBinding = undefined;
        for (let i = 0; i < node.props.length; i++) {
            const prop = node.props[i];
            // ignore true-value/false-value on input
            if (node.tag === 'input' && isTrueFalseValue(prop)) {
                continue;
            }
            // special cases with children override
            if (prop.type === 7 /* DIRECTIVE */) {
                if (prop.name === 'html' && prop.exp) {
                    rawChildrenMap.set(node, prop.exp);
                }
                else if (prop.name === 'text' && prop.exp) {
                    node.children = [createInterpolation(prop.exp, prop.loc)];
                }
                else if (prop.name === 'slot') {
                    context.onError(createCompilerError(39 /* X_V_SLOT_MISPLACED */, prop.loc));
                }
                else if (isTextareaWithValue(node, prop) && prop.exp) {
                    if (!hasDynamicVBind) {
                        node.children = [createInterpolation(prop.exp, prop.loc)];
                    }
                }
                else {
                    // Directive transforms.
                    const directiveTransform = context.directiveTransforms[prop.name];
                    if (!directiveTransform) {
                        // no corresponding ssr directive transform found.
                        context.onError(createSSRCompilerError(60 /* X_SSR_CUSTOM_DIRECTIVE_NO_TRANSFORM */, prop.loc));
                    }
                    else if (!hasDynamicVBind) {
                        const { props, ssrTagParts } = directiveTransform(prop, node, context);
                        if (ssrTagParts) {
                            openTag.push(...ssrTagParts);
                        }
                        for (let j = 0; j < props.length; j++) {
                            const { key, value } = props[j];
                            if (isStaticExp(key)) {
                                let attrName = key.content;
                                // static key attr
                                if (attrName === 'key' || attrName === 'ref') {
                                    continue;
                                }
                                if (attrName === 'class') {
                                    openTag.push(` class="`, (dynamicClassBinding = createCallExpression(context.helper(SSR_RENDER_CLASS), [value])), `"`);
                                }
                                else if (attrName === 'style') {
                                    if (dynamicStyleBinding) {
                                        // already has style binding, merge into it.
                                        mergeCall(dynamicStyleBinding, value);
                                    }
                                    else {
                                        openTag.push(` style="`, (dynamicStyleBinding = createCallExpression(context.helper(SSR_RENDER_STYLE), [value])), `"`);
                                    }
                                }
                                else {
                                    attrName =
                                        node.tag.indexOf('-') > 0
                                            ? attrName // preserve raw name on custom elements
                                            : propsToAttrMap[attrName] || attrName.toLowerCase();
                                    if (isBooleanAttr(attrName)) {
                                        openTag.push(createConditionalExpression(value, createSimpleExpression(' ' + attrName, true), createSimpleExpression('', true), false /* no newline */));
                                    }
                                    else if (isSSRSafeAttrName(attrName)) {
                                        openTag.push(createCallExpression(context.helper(SSR_RENDER_ATTR), [
                                            key,
                                            value
                                        ]));
                                    }
                                    else {
                                        context.onError(createSSRCompilerError(61 /* X_SSR_UNSAFE_ATTR_NAME */, key.loc));
                                    }
                                }
                            }
                            else {
                                // dynamic key attr
                                // this branch is only encountered for custom directive
                                // transforms that returns properties with dynamic keys
                                const args = [key, value];
                                if (needTagForRuntime) {
                                    args.push(`"${node.tag}"`);
                                }
                                openTag.push(createCallExpression(context.helper(SSR_RENDER_DYNAMIC_ATTR), args));
                            }
                        }
                    }
                }
            }
            else {
                // special case: value on <textarea>
                if (node.tag === 'textarea' && prop.name === 'value' && prop.value) {
                    rawChildrenMap.set(node, escapeHtml(prop.value.content));
                }
                else if (!hasDynamicVBind) {
                    if (prop.name === 'key' || prop.name === 'ref') {
                        continue;
                    }
                    // static prop
                    if (prop.name === 'class' && prop.value) {
                        staticClassBinding = JSON.stringify(prop.value.content);
                    }
                    openTag.push(` ${prop.name}` +
                        (prop.value ? `="${escapeHtml(prop.value.content)}"` : ``));
                }
            }
        }
        // handle co-existence of dynamic + static class bindings
        if (dynamicClassBinding && staticClassBinding) {
            mergeCall(dynamicClassBinding, staticClassBinding);
            removeStaticBinding(openTag, 'class');
        }
        if (context.scopeId) {
            openTag.push(` ${context.scopeId}`);
        }
        node.ssrCodegenNode = createTemplateLiteral(openTag);
    };
};
function isTrueFalseValue(prop) {
    if (prop.type === 7 /* DIRECTIVE */) {
        return (prop.name === 'bind' &&
            prop.arg &&
            isStaticExp(prop.arg) &&
            (prop.arg.content === 'true-value' || prop.arg.content === 'false-value'));
    }
    else {
        return prop.name === 'true-value' || prop.name === 'false-value';
    }
}
function isTextareaWithValue(node, prop) {
    return !!(node.tag === 'textarea' &&
        prop.name === 'bind' &&
        isBindKey(prop.arg, 'value'));
}
function mergeCall(call, arg) {
    const existing = call.arguments[0];
    if (existing.type === 17 /* JS_ARRAY_EXPRESSION */) {
        existing.elements.push(arg);
    }
    else {
        call.arguments[0] = createArrayExpression([existing, arg]);
    }
}
function removeStaticBinding(tag, binding) {
    const regExp = new RegExp(`^ ${binding}=".+"$`);
    const i = tag.findIndex(e => typeof e === 'string' && regExp.test(e));
    if (i > -1) {
        tag.splice(i, 1);
    }
}
function findVModel(node) {
    return node.props.find(p => p.type === 7 /* DIRECTIVE */ && p.name === 'model' && p.exp);
}
function ssrProcessElement(node, context) {
    const isVoidTag = context.options.isVoidTag || NO;
    const elementsToAdd = node.ssrCodegenNode.elements;
    for (let j = 0; j < elementsToAdd.length; j++) {
        context.pushStringPart(elementsToAdd[j]);
    }
    // Handle slot scopeId
    if (context.withSlotScopeId) {
        context.pushStringPart(createSimpleExpression(`_scopeId`, false));
    }
    // close open tag
    context.pushStringPart(`>`);
    const rawChildren = rawChildrenMap.get(node);
    if (rawChildren) {
        context.pushStringPart(rawChildren);
    }
    else if (node.children.length) {
        processChildren(node.children, context);
    }
    if (!isVoidTag(node.tag)) {
        // push closing tag
        context.pushStringPart(`</${node.tag}>`);
    }
}

// Because SSR codegen output is completely different from client-side output
// (e.g. multiple elements can be concatenated into a single template literal
// instead of each getting a corresponding call), we need to apply an extra
// transform pass to convert the template AST into a fresh JS AST before
// passing it to codegen.
function ssrCodegenTransform(ast, options) {
    const context = createSSRTransformContext(ast, options);
    // inject SFC <style> CSS variables
    // we do this instead of inlining the expression to ensure the vars are
    // only resolved once per render
    if (options.ssrCssVars) {
        const varsExp = processExpression(createSimpleExpression(options.ssrCssVars, false), createTransformContext(createRoot([]), options));
        context.body.push(createCompoundExpression([`const _cssVars = { style: `, varsExp, `}`]));
    }
    const isFragment = ast.children.length > 1 && ast.children.some(c => !isText(c));
    processChildren(ast.children, context, isFragment);
    ast.codegenNode = createBlockStatement(context.body);
    // Finalize helpers.
    // We need to separate helpers imported from 'vue' vs. '@vue/server-renderer'
    ast.ssrHelpers = Array.from(new Set([
        ...ast.helpers.filter(h => h in ssrHelpers),
        ...context.helpers
    ]));
    ast.helpers = ast.helpers.filter(h => !(h in ssrHelpers));
}
function createSSRTransformContext(root, options, helpers = new Set(), withSlotScopeId = false) {
    const body = [];
    let currentString = null;
    return {
        root,
        options,
        body,
        helpers,
        withSlotScopeId,
        onError: options.onError ||
            (e => {
                throw e;
            }),
        helper(name) {
            helpers.add(name);
            return name;
        },
        pushStringPart(part) {
            if (!currentString) {
                const currentCall = createCallExpression(`_push`);
                body.push(currentCall);
                currentString = createTemplateLiteral([]);
                currentCall.arguments.push(currentString);
            }
            const bufferedElements = currentString.elements;
            const lastItem = bufferedElements[bufferedElements.length - 1];
            if (isString(part) && isString(lastItem)) {
                bufferedElements[bufferedElements.length - 1] += part;
            }
            else {
                bufferedElements.push(part);
            }
        },
        pushStatement(statement) {
            // close current string
            currentString = null;
            body.push(statement);
        }
    };
}
function createChildContext(parent, withSlotScopeId = parent.withSlotScopeId) {
    // ensure child inherits parent helpers
    return createSSRTransformContext(parent.root, parent.options, parent.helpers, withSlotScopeId);
}
function processChildren(children, context, asFragment = false, disableNestedFragments = false) {
    if (asFragment) {
        context.pushStringPart(`<!--[-->`);
    }
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        switch (child.type) {
            case 1 /* ELEMENT */:
                switch (child.tagType) {
                    case 0 /* ELEMENT */:
                        ssrProcessElement(child, context);
                        break;
                    case 1 /* COMPONENT */:
                        ssrProcessComponent(child, context);
                        break;
                    case 2 /* SLOT */:
                        ssrProcessSlotOutlet(child, context);
                        break;
                    case 3 /* TEMPLATE */:
                        // TODO
                        break;
                    default:
                        context.onError(createSSRCompilerError(63 /* X_SSR_INVALID_AST_NODE */, child.loc));
                        // make sure we exhaust all possible types
                        const exhaustiveCheck = child;
                        return exhaustiveCheck;
                }
                break;
            case 2 /* TEXT */:
                context.pushStringPart(escapeHtml(child.content));
                break;
            case 3 /* COMMENT */:
                // no need to escape comment here because the AST can only
                // contain valid comments.
                context.pushStringPart(`<!--${child.content}-->`);
                break;
            case 5 /* INTERPOLATION */:
                context.pushStringPart(createCallExpression(context.helper(SSR_INTERPOLATE), [child.content]));
                break;
            case 9 /* IF */:
                ssrProcessIf(child, context, disableNestedFragments);
                break;
            case 11 /* FOR */:
                ssrProcessFor(child, context, disableNestedFragments);
                break;
            case 10 /* IF_BRANCH */:
                // no-op - handled by ssrProcessIf
                break;
            case 12 /* TEXT_CALL */:
            case 8 /* COMPOUND_EXPRESSION */:
                // no-op - these two types can never appear as template child node since
                // `transformText` is not used during SSR compile.
                break;
            default:
                context.onError(createSSRCompilerError(63 /* X_SSR_INVALID_AST_NODE */, child.loc));
                // make sure we exhaust all possible types
                const exhaustiveCheck = child;
                return exhaustiveCheck;
        }
    }
    if (asFragment) {
        context.pushStringPart(`<!--]-->`);
    }
}
function processChildrenAsStatement(children, parentContext, asFragment = false, withSlotScopeId = parentContext.withSlotScopeId) {
    const childContext = createChildContext(parentContext, withSlotScopeId);
    processChildren(children, childContext, asFragment);
    return createBlockStatement(childContext.body);
}

const ssrTransformModel = (dir, node, context) => {
    const model = dir.exp;
    function checkDuplicatedValue() {
        const value = findProp(node, 'value');
        if (value) {
            context.onError(createDOMCompilerError(56 /* X_V_MODEL_UNNECESSARY_VALUE */, value.loc));
        }
    }
    if (node.tagType === 0 /* ELEMENT */) {
        const res = { props: [] };
        const defaultProps = [
            // default value binding for text type inputs
            createObjectProperty(`value`, model)
        ];
        if (node.tag === 'input') {
            const type = findProp(node, 'type');
            if (type) {
                const value = findValueBinding(node);
                if (type.type === 7 /* DIRECTIVE */) {
                    // dynamic type
                    res.ssrTagParts = [
                        createCallExpression(context.helper(SSR_RENDER_DYNAMIC_MODEL), [
                            type.exp,
                            model,
                            value
                        ])
                    ];
                }
                else if (type.value) {
                    // static type
                    switch (type.value.content) {
                        case 'radio':
                            res.props = [
                                createObjectProperty(`checked`, createCallExpression(context.helper(SSR_LOOSE_EQUAL), [
                                    model,
                                    value
                                ]))
                            ];
                            break;
                        case 'checkbox':
                            const trueValueBinding = findProp(node, 'true-value');
                            if (trueValueBinding) {
                                const trueValue = trueValueBinding.type === 6 /* ATTRIBUTE */
                                    ? JSON.stringify(trueValueBinding.value.content)
                                    : trueValueBinding.exp;
                                res.props = [
                                    createObjectProperty(`checked`, createCallExpression(context.helper(SSR_LOOSE_EQUAL), [
                                        model,
                                        trueValue
                                    ]))
                                ];
                            }
                            else {
                                res.props = [
                                    createObjectProperty(`checked`, createConditionalExpression(createCallExpression(`Array.isArray`, [model]), createCallExpression(context.helper(SSR_LOOSE_CONTAIN), [
                                        model,
                                        value
                                    ]), model))
                                ];
                            }
                            break;
                        case 'file':
                            context.onError(createDOMCompilerError(55 /* X_V_MODEL_ON_FILE_INPUT_ELEMENT */, dir.loc));
                            break;
                        default:
                            checkDuplicatedValue();
                            res.props = defaultProps;
                            break;
                    }
                }
            }
            else if (hasDynamicKeyVBind(node)) ;
            else {
                // text type
                checkDuplicatedValue();
                res.props = defaultProps;
            }
        }
        else if (node.tag === 'textarea') {
            checkDuplicatedValue();
            node.children = [createInterpolation(model, model.loc)];
        }
        else if (node.tag === 'select') ;
        else {
            context.onError(createDOMCompilerError(53 /* X_V_MODEL_ON_INVALID_ELEMENT */, dir.loc));
        }
        return res;
    }
    else {
        // component v-model
        return transformModel(dir, node, context);
    }
};
function findValueBinding(node) {
    const valueBinding = findProp(node, 'value');
    return valueBinding
        ? valueBinding.type === 7 /* DIRECTIVE */
            ? valueBinding.exp
            : createSimpleExpression(valueBinding.value.content, true)
        : createSimpleExpression(`null`, false);
}

const ssrTransformShow = (dir, node, context) => {
    if (!dir.exp) {
        context.onError(createDOMCompilerError(57 /* X_V_SHOW_NO_EXPRESSION */));
    }
    return {
        props: [
            createObjectProperty(`style`, createConditionalExpression(dir.exp, createSimpleExpression(`null`, false), createObjectExpression([
                createObjectProperty(`display`, createSimpleExpression(`none`, true))
            ]), false /* no newline */))
        ]
    };
};

const hasSingleChild = (node) => node.children.filter(n => n.type !== 3 /* COMMENT */).length === 1;
const ssrInjectFallthroughAttrs = (node, context) => {
    // _attrs is provided as a function argument.
    // mark it as a known identifier so that it doesn't get prefixed by
    // transformExpression.
    if (node.type === 0 /* ROOT */) {
        context.identifiers._attrs = 1;
    }
    const parent = context.parent;
    if (!parent || parent.type !== 0 /* ROOT */) {
        return;
    }
    if (node.type === 10 /* IF_BRANCH */ && hasSingleChild(node)) {
        injectFallthroughAttrs(node.children[0]);
    }
    else if (hasSingleChild(parent)) {
        injectFallthroughAttrs(node);
    }
};
function injectFallthroughAttrs(node) {
    if (node.type === 1 /* ELEMENT */ &&
        (node.tagType === 0 /* ELEMENT */ ||
            node.tagType === 1 /* COMPONENT */) &&
        !findDir(node, 'for')) {
        node.props.push({
            type: 7 /* DIRECTIVE */,
            name: 'bind',
            arg: undefined,
            exp: createSimpleExpression(`_attrs`, false),
            modifiers: [],
            loc: locStub
        });
    }
}

const ssrInjectCssVars = (node, context) => {
    if (!context.ssrCssVars) {
        return;
    }
    // _cssVars is initialized once per render function
    // the code is injected in ssrCodegenTransform when creating the
    // ssr transform context
    if (node.type === 0 /* ROOT */) {
        context.identifiers._cssVars = 1;
    }
    const parent = context.parent;
    if (!parent || parent.type !== 0 /* ROOT */) {
        return;
    }
    if (node.type === 10 /* IF_BRANCH */) {
        for (const child of node.children) {
            injectCssVars(child);
        }
    }
    else {
        injectCssVars(node);
    }
};
function injectCssVars(node) {
    if (node.type === 1 /* ELEMENT */ &&
        (node.tagType === 0 /* ELEMENT */ ||
            node.tagType === 1 /* COMPONENT */) &&
        !findDir(node, 'for')) {
        if (isBuiltInType(node.tag, 'Suspense')) {
            for (const child of node.children) {
                if (child.type === 1 /* ELEMENT */ &&
                    child.tagType === 3 /* TEMPLATE */) {
                    // suspense slot
                    child.children.forEach(injectCssVars);
                }
                else {
                    injectCssVars(child);
                }
            }
        }
        else {
            node.props.push({
                type: 7 /* DIRECTIVE */,
                name: 'bind',
                arg: undefined,
                exp: createSimpleExpression(`_cssVars`, false),
                modifiers: [],
                loc: locStub
            });
        }
    }
}

function compile$1(template, options = {}) {
    options = {
        ...options,
        // apply DOM-specific parsing options
        ...parserOptions,
        ssr: true,
        scopeId: options.mode === 'function' ? null : options.scopeId,
        // always prefix since compiler-ssr doesn't have size concern
        prefixIdentifiers: true,
        // disable optimizations that are unnecessary for ssr
        cacheHandlers: false,
        hoistStatic: false
    };
    const ast = baseParse(template, options);
    // Save raw options for AST. This is needed when performing sub-transforms
    // on slot vnode branches.
    rawOptionsMap.set(ast, options);
    transform(ast, {
        ...options,
        nodeTransforms: [
            ssrTransformIf,
            ssrTransformFor,
            trackVForSlotScopes,
            transformExpression,
            ssrTransformSlotOutlet,
            ssrInjectFallthroughAttrs,
            ssrInjectCssVars,
            ssrTransformElement,
            ssrTransformComponent,
            trackSlotScopes,
            transformStyle,
            ...(options.nodeTransforms || []) // user transforms
        ],
        directiveTransforms: {
            // reusing core v-bind
            bind: transformBind,
            // model and show has dedicated SSR handling
            model: ssrTransformModel,
            show: ssrTransformShow,
            // the following are ignored during SSR
            on: noopDirectiveTransform,
            cloak: noopDirectiveTransform,
            once: noopDirectiveTransform,
            ...(options.directiveTransforms || {}) // user transforms
        }
    });
    // traverse the template AST and convert into SSR codegen AST
    // by replacing ast.codegenNode.
    ssrCodegenTransform(ast, options);
    return generate(ast, options);
}

const targetMap = new WeakMap();
const effectStack = [];
let activeEffect;
const ITERATE_KEY = Symbol('iterate' );
const MAP_KEY_ITERATE_KEY = Symbol('Map key iterate' );
function isEffect(fn) {
    return fn && fn._isEffect === true;
}
function effect(fn, options = EMPTY_OBJ) {
    if (isEffect(fn)) {
        fn = fn.raw;
    }
    const effect = createReactiveEffect(fn, options);
    if (!options.lazy) {
        effect();
    }
    return effect;
}
function stop(effect) {
    if (effect.active) {
        cleanup(effect);
        if (effect.options.onStop) {
            effect.options.onStop();
        }
        effect.active = false;
    }
}
let uid = 0;
function createReactiveEffect(fn, options) {
    const effect = function reactiveEffect() {
        if (!effect.active) {
            return options.scheduler ? undefined : fn();
        }
        if (!effectStack.includes(effect)) {
            cleanup(effect);
            try {
                enableTracking();
                effectStack.push(effect);
                activeEffect = effect;
                return fn();
            }
            finally {
                effectStack.pop();
                resetTracking();
                activeEffect = effectStack[effectStack.length - 1];
            }
        }
    };
    effect.id = uid++;
    effect.allowRecurse = !!options.allowRecurse;
    effect._isEffect = true;
    effect.active = true;
    effect.raw = fn;
    effect.deps = [];
    effect.options = options;
    return effect;
}
function cleanup(effect) {
    const { deps } = effect;
    if (deps.length) {
        for (let i = 0; i < deps.length; i++) {
            deps[i].delete(effect);
        }
        deps.length = 0;
    }
}
let shouldTrack = true;
const trackStack = [];
function pauseTracking() {
    trackStack.push(shouldTrack);
    shouldTrack = false;
}
function enableTracking() {
    trackStack.push(shouldTrack);
    shouldTrack = true;
}
function resetTracking() {
    const last = trackStack.pop();
    shouldTrack = last === undefined ? true : last;
}
function track(target, type, key) {
    if (!shouldTrack || activeEffect === undefined) {
        return;
    }
    let depsMap = targetMap.get(target);
    if (!depsMap) {
        targetMap.set(target, (depsMap = new Map()));
    }
    let dep = depsMap.get(key);
    if (!dep) {
        depsMap.set(key, (dep = new Set()));
    }
    if (!dep.has(activeEffect)) {
        dep.add(activeEffect);
        activeEffect.deps.push(dep);
        if (activeEffect.options.onTrack) {
            activeEffect.options.onTrack({
                effect: activeEffect,
                target,
                type,
                key
            });
        }
    }
}
function trigger(target, type, key, newValue, oldValue, oldTarget) {
    const depsMap = targetMap.get(target);
    if (!depsMap) {
        // never been tracked
        return;
    }
    const effects = new Set();
    const add = (effectsToAdd) => {
        if (effectsToAdd) {
            effectsToAdd.forEach(effect => {
                if (effect !== activeEffect || effect.allowRecurse) {
                    effects.add(effect);
                }
            });
        }
    };
    if (type === "clear" /* CLEAR */) {
        // collection being cleared
        // trigger all effects for target
        depsMap.forEach(add);
    }
    else if (key === 'length' && isArray(target)) {
        depsMap.forEach((dep, key) => {
            if (key === 'length' || key >= newValue) {
                add(dep);
            }
        });
    }
    else {
        // schedule runs for SET | ADD | DELETE
        if (key !== void 0) {
            add(depsMap.get(key));
        }
        // also run for iteration key on ADD | DELETE | Map.SET
        switch (type) {
            case "add" /* ADD */:
                if (!isArray(target)) {
                    add(depsMap.get(ITERATE_KEY));
                    if (isMap(target)) {
                        add(depsMap.get(MAP_KEY_ITERATE_KEY));
                    }
                }
                else if (isIntegerKey(key)) {
                    // new index added to array -> length changes
                    add(depsMap.get('length'));
                }
                break;
            case "delete" /* DELETE */:
                if (!isArray(target)) {
                    add(depsMap.get(ITERATE_KEY));
                    if (isMap(target)) {
                        add(depsMap.get(MAP_KEY_ITERATE_KEY));
                    }
                }
                break;
            case "set" /* SET */:
                if (isMap(target)) {
                    add(depsMap.get(ITERATE_KEY));
                }
                break;
        }
    }
    const run = (effect) => {
        if (effect.options.onTrigger) {
            effect.options.onTrigger({
                effect,
                target,
                key,
                type,
                newValue,
                oldValue,
                oldTarget
            });
        }
        if (effect.options.scheduler) {
            effect.options.scheduler(effect);
        }
        else {
            effect();
        }
    };
    effects.forEach(run);
}

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`);
const builtInSymbols = new Set(Object.getOwnPropertyNames(Symbol)
    .map(key => Symbol[key])
    .filter(isSymbol));
const get = /*#__PURE__*/ createGetter();
const shallowGet = /*#__PURE__*/ createGetter(false, true);
const readonlyGet = /*#__PURE__*/ createGetter(true);
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true);
const arrayInstrumentations = {};
['includes', 'indexOf', 'lastIndexOf'].forEach(key => {
    const method = Array.prototype[key];
    arrayInstrumentations[key] = function (...args) {
        const arr = toRaw(this);
        for (let i = 0, l = this.length; i < l; i++) {
            track(arr, "get" /* GET */, i + '');
        }
        // we run the method using the original args first (which may be reactive)
        const res = arr[key].apply(this, args);
        if (res === -1 || res === false) {
            // if that didn't work, run it again using raw values.
            return method.apply(arr, args.map(toRaw));
        }
        else {
            return res;
        }
    };
});
['push', 'pop', 'shift', 'unshift', 'splice'].forEach(key => {
    arrayInstrumentations[key] = function (...args) {
        pauseTracking();
        const arr = toRaw(this);
        const res = arr[key].apply(this, args);
        resetTracking();
        return res;
    };
});
function createGetter(isReadonly = false, shallow = false) {
    return function get(target, key, receiver) {
        if (key === "__v_isReactive" /* IS_REACTIVE */) {
            return !isReadonly;
        }
        else if (key === "__v_isReadonly" /* IS_READONLY */) {
            return isReadonly;
        }
        else if (key === "__v_raw" /* RAW */ &&
            receiver ===
                (isReadonly
                    ? shallow
                        ? shallowReadonlyMap
                        : readonlyMap
                    : shallow
                        ? shallowReactiveMap
                        : reactiveMap).get(target)) {
            return target;
        }
        const targetIsArray = isArray(target);
        if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
            return Reflect.get(arrayInstrumentations, key, receiver);
        }
        const res = Reflect.get(target, key, receiver);
        if (isSymbol(key)
            ? builtInSymbols.has(key)
            : isNonTrackableKeys(key)) {
            return res;
        }
        if (!isReadonly) {
            track(target, "get" /* GET */, key);
        }
        if (shallow) {
            return res;
        }
        if (isRef(res)) {
            // ref unwrapping - does not apply for Array + integer key.
            const shouldUnwrap = !targetIsArray || !isIntegerKey(key);
            return shouldUnwrap ? res.value : res;
        }
        if (isObject(res)) {
            // Convert returned value into a proxy as well. we do the isObject check
            // here to avoid invalid value warning. Also need to lazy access readonly
            // and reactive here to avoid circular dependency.
            return isReadonly ? readonly(res) : reactive(res);
        }
        return res;
    };
}
const set = /*#__PURE__*/ createSetter();
const shallowSet = /*#__PURE__*/ createSetter(true);
function createSetter(shallow = false) {
    return function set(target, key, value, receiver) {
        let oldValue = target[key];
        if (!shallow) {
            value = toRaw(value);
            oldValue = toRaw(oldValue);
            if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
                oldValue.value = value;
                return true;
            }
        }
        const hadKey = isArray(target) && isIntegerKey(key)
            ? Number(key) < target.length
            : hasOwn(target, key);
        const result = Reflect.set(target, key, value, receiver);
        // don't trigger if target is something up in the prototype chain of original
        if (target === toRaw(receiver)) {
            if (!hadKey) {
                trigger(target, "add" /* ADD */, key, value);
            }
            else if (hasChanged(value, oldValue)) {
                trigger(target, "set" /* SET */, key, value, oldValue);
            }
        }
        return result;
    };
}
function deleteProperty(target, key) {
    const hadKey = hasOwn(target, key);
    const oldValue = target[key];
    const result = Reflect.deleteProperty(target, key);
    if (result && hadKey) {
        trigger(target, "delete" /* DELETE */, key, undefined, oldValue);
    }
    return result;
}
function has(target, key) {
    const result = Reflect.has(target, key);
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
        track(target, "has" /* HAS */, key);
    }
    return result;
}
function ownKeys(target) {
    track(target, "iterate" /* ITERATE */, isArray(target) ? 'length' : ITERATE_KEY);
    return Reflect.ownKeys(target);
}
const mutableHandlers = {
    get,
    set,
    deleteProperty,
    has,
    ownKeys
};
const readonlyHandlers = {
    get: readonlyGet,
    set(target, key) {
        {
            console.warn(`Set operation on key "${String(key)}" failed: target is readonly.`, target);
        }
        return true;
    },
    deleteProperty(target, key) {
        {
            console.warn(`Delete operation on key "${String(key)}" failed: target is readonly.`, target);
        }
        return true;
    }
};
const shallowReactiveHandlers = extend({}, mutableHandlers, {
    get: shallowGet,
    set: shallowSet
});
// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
const shallowReadonlyHandlers = extend({}, readonlyHandlers, {
    get: shallowReadonlyGet
});

const toReactive = (value) => isObject(value) ? reactive(value) : value;
const toReadonly = (value) => isObject(value) ? readonly(value) : value;
const toShallow = (value) => value;
const getProto = (v) => Reflect.getPrototypeOf(v);
function get$1(target, key, isReadonly = false, isShallow = false) {
    // #1772: readonly(reactive(Map)) should return readonly + reactive version
    // of the value
    target = target["__v_raw" /* RAW */];
    const rawTarget = toRaw(target);
    const rawKey = toRaw(key);
    if (key !== rawKey) {
        !isReadonly && track(rawTarget, "get" /* GET */, key);
    }
    !isReadonly && track(rawTarget, "get" /* GET */, rawKey);
    const { has } = getProto(rawTarget);
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive;
    if (has.call(rawTarget, key)) {
        return wrap(target.get(key));
    }
    else if (has.call(rawTarget, rawKey)) {
        return wrap(target.get(rawKey));
    }
}
function has$1(key, isReadonly = false) {
    const target = this["__v_raw" /* RAW */];
    const rawTarget = toRaw(target);
    const rawKey = toRaw(key);
    if (key !== rawKey) {
        !isReadonly && track(rawTarget, "has" /* HAS */, key);
    }
    !isReadonly && track(rawTarget, "has" /* HAS */, rawKey);
    return key === rawKey
        ? target.has(key)
        : target.has(key) || target.has(rawKey);
}
function size(target, isReadonly = false) {
    target = target["__v_raw" /* RAW */];
    !isReadonly && track(toRaw(target), "iterate" /* ITERATE */, ITERATE_KEY);
    return Reflect.get(target, 'size', target);
}
function add(value) {
    value = toRaw(value);
    const target = toRaw(this);
    const proto = getProto(target);
    const hadKey = proto.has.call(target, value);
    if (!hadKey) {
        target.add(value);
        trigger(target, "add" /* ADD */, value, value);
    }
    return this;
}
function set$1(key, value) {
    value = toRaw(value);
    const target = toRaw(this);
    const { has, get } = getProto(target);
    let hadKey = has.call(target, key);
    if (!hadKey) {
        key = toRaw(key);
        hadKey = has.call(target, key);
    }
    else {
        checkIdentityKeys(target, has, key);
    }
    const oldValue = get.call(target, key);
    target.set(key, value);
    if (!hadKey) {
        trigger(target, "add" /* ADD */, key, value);
    }
    else if (hasChanged(value, oldValue)) {
        trigger(target, "set" /* SET */, key, value, oldValue);
    }
    return this;
}
function deleteEntry(key) {
    const target = toRaw(this);
    const { has, get } = getProto(target);
    let hadKey = has.call(target, key);
    if (!hadKey) {
        key = toRaw(key);
        hadKey = has.call(target, key);
    }
    else {
        checkIdentityKeys(target, has, key);
    }
    const oldValue = get ? get.call(target, key) : undefined;
    // forward the operation before queueing reactions
    const result = target.delete(key);
    if (hadKey) {
        trigger(target, "delete" /* DELETE */, key, undefined, oldValue);
    }
    return result;
}
function clear() {
    const target = toRaw(this);
    const hadItems = target.size !== 0;
    const oldTarget = isMap(target)
            ? new Map(target)
            : new Set(target)
        ;
    // forward the operation before queueing reactions
    const result = target.clear();
    if (hadItems) {
        trigger(target, "clear" /* CLEAR */, undefined, undefined, oldTarget);
    }
    return result;
}
function createForEach(isReadonly, isShallow) {
    return function forEach(callback, thisArg) {
        const observed = this;
        const target = observed["__v_raw" /* RAW */];
        const rawTarget = toRaw(target);
        const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive;
        !isReadonly && track(rawTarget, "iterate" /* ITERATE */, ITERATE_KEY);
        return target.forEach((value, key) => {
            // important: make sure the callback is
            // 1. invoked with the reactive map as `this` and 3rd arg
            // 2. the value received should be a corresponding reactive/readonly.
            return callback.call(thisArg, wrap(value), wrap(key), observed);
        });
    };
}
function createIterableMethod(method, isReadonly, isShallow) {
    return function (...args) {
        const target = this["__v_raw" /* RAW */];
        const rawTarget = toRaw(target);
        const targetIsMap = isMap(rawTarget);
        const isPair = method === 'entries' || (method === Symbol.iterator && targetIsMap);
        const isKeyOnly = method === 'keys' && targetIsMap;
        const innerIterator = target[method](...args);
        const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive;
        !isReadonly &&
            track(rawTarget, "iterate" /* ITERATE */, isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY);
        // return a wrapped iterator which returns observed versions of the
        // values emitted from the real iterator
        return {
            // iterator protocol
            next() {
                const { value, done } = innerIterator.next();
                return done
                    ? { value, done }
                    : {
                        value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
                        done
                    };
            },
            // iterable protocol
            [Symbol.iterator]() {
                return this;
            }
        };
    };
}
function createReadonlyMethod(type) {
    return function (...args) {
        {
            const key = args[0] ? `on key "${args[0]}" ` : ``;
            console.warn(`${capitalize(type)} operation ${key}failed: target is readonly.`, toRaw(this));
        }
        return type === "delete" /* DELETE */ ? false : this;
    };
}
const mutableInstrumentations = {
    get(key) {
        return get$1(this, key);
    },
    get size() {
        return size(this);
    },
    has: has$1,
    add,
    set: set$1,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, false)
};
const shallowInstrumentations = {
    get(key) {
        return get$1(this, key, false, true);
    },
    get size() {
        return size(this);
    },
    has: has$1,
    add,
    set: set$1,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, true)
};
const readonlyInstrumentations = {
    get(key) {
        return get$1(this, key, true);
    },
    get size() {
        return size(this, true);
    },
    has(key) {
        return has$1.call(this, key, true);
    },
    add: createReadonlyMethod("add" /* ADD */),
    set: createReadonlyMethod("set" /* SET */),
    delete: createReadonlyMethod("delete" /* DELETE */),
    clear: createReadonlyMethod("clear" /* CLEAR */),
    forEach: createForEach(true, false)
};
const shallowReadonlyInstrumentations = {
    get(key) {
        return get$1(this, key, true, true);
    },
    get size() {
        return size(this, true);
    },
    has(key) {
        return has$1.call(this, key, true);
    },
    add: createReadonlyMethod("add" /* ADD */),
    set: createReadonlyMethod("set" /* SET */),
    delete: createReadonlyMethod("delete" /* DELETE */),
    clear: createReadonlyMethod("clear" /* CLEAR */),
    forEach: createForEach(true, true)
};
const iteratorMethods = ['keys', 'values', 'entries', Symbol.iterator];
iteratorMethods.forEach(method => {
    mutableInstrumentations[method] = createIterableMethod(method, false, false);
    readonlyInstrumentations[method] = createIterableMethod(method, true, false);
    shallowInstrumentations[method] = createIterableMethod(method, false, true);
    shallowReadonlyInstrumentations[method] = createIterableMethod(method, true, true);
});
function createInstrumentationGetter(isReadonly, shallow) {
    const instrumentations = shallow
        ? isReadonly
            ? shallowReadonlyInstrumentations
            : shallowInstrumentations
        : isReadonly
            ? readonlyInstrumentations
            : mutableInstrumentations;
    return (target, key, receiver) => {
        if (key === "__v_isReactive" /* IS_REACTIVE */) {
            return !isReadonly;
        }
        else if (key === "__v_isReadonly" /* IS_READONLY */) {
            return isReadonly;
        }
        else if (key === "__v_raw" /* RAW */) {
            return target;
        }
        return Reflect.get(hasOwn(instrumentations, key) && key in target
            ? instrumentations
            : target, key, receiver);
    };
}
const mutableCollectionHandlers = {
    get: createInstrumentationGetter(false, false)
};
const shallowCollectionHandlers = {
    get: createInstrumentationGetter(false, true)
};
const readonlyCollectionHandlers = {
    get: createInstrumentationGetter(true, false)
};
const shallowReadonlyCollectionHandlers = {
    get: createInstrumentationGetter(true, true)
};
function checkIdentityKeys(target, has, key) {
    const rawKey = toRaw(key);
    if (rawKey !== key && has.call(target, rawKey)) {
        const type = toRawType(target);
        console.warn(`Reactive ${type} contains both the raw and reactive ` +
            `versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
            `which can lead to inconsistencies. ` +
            `Avoid differentiating between the raw and reactive versions ` +
            `of an object and only use the reactive version if possible.`);
    }
}

const reactiveMap = new WeakMap();
const shallowReactiveMap = new WeakMap();
const readonlyMap = new WeakMap();
const shallowReadonlyMap = new WeakMap();
function targetTypeMap(rawType) {
    switch (rawType) {
        case 'Object':
        case 'Array':
            return 1 /* COMMON */;
        case 'Map':
        case 'Set':
        case 'WeakMap':
        case 'WeakSet':
            return 2 /* COLLECTION */;
        default:
            return 0 /* INVALID */;
    }
}
function getTargetType(value) {
    return value["__v_skip" /* SKIP */] || !Object.isExtensible(value)
        ? 0 /* INVALID */
        : targetTypeMap(toRawType(value));
}
function reactive(target) {
    // if trying to observe a readonly proxy, return the readonly version.
    if (target && target["__v_isReadonly" /* IS_READONLY */]) {
        return target;
    }
    return createReactiveObject(target, false, mutableHandlers, mutableCollectionHandlers, reactiveMap);
}
/**
 * Return a shallowly-reactive copy of the original object, where only the root
 * level properties are reactive. It also does not auto-unwrap refs (even at the
 * root level).
 */
function shallowReactive(target) {
    return createReactiveObject(target, false, shallowReactiveHandlers, shallowCollectionHandlers, shallowReactiveMap);
}
/**
 * Creates a readonly copy of the original object. Note the returned copy is not
 * made reactive, but `readonly` can be called on an already reactive object.
 */
function readonly(target) {
    return createReactiveObject(target, true, readonlyHandlers, readonlyCollectionHandlers, readonlyMap);
}
/**
 * Returns a reactive-copy of the original object, where only the root level
 * properties are readonly, and does NOT unwrap refs nor recursively convert
 * returned properties.
 * This is used for creating the props proxy object for stateful components.
 */
function shallowReadonly(target) {
    return createReactiveObject(target, true, shallowReadonlyHandlers, shallowReadonlyCollectionHandlers, shallowReadonlyMap);
}
function createReactiveObject(target, isReadonly, baseHandlers, collectionHandlers, proxyMap) {
    if (!isObject(target)) {
        {
            console.warn(`value cannot be made reactive: ${String(target)}`);
        }
        return target;
    }
    // target is already a Proxy, return it.
    // exception: calling readonly() on a reactive object
    if (target["__v_raw" /* RAW */] &&
        !(isReadonly && target["__v_isReactive" /* IS_REACTIVE */])) {
        return target;
    }
    // target already has corresponding Proxy
    const existingProxy = proxyMap.get(target);
    if (existingProxy) {
        return existingProxy;
    }
    // only a whitelist of value types can be observed.
    const targetType = getTargetType(target);
    if (targetType === 0 /* INVALID */) {
        return target;
    }
    const proxy = new Proxy(target, targetType === 2 /* COLLECTION */ ? collectionHandlers : baseHandlers);
    proxyMap.set(target, proxy);
    return proxy;
}
function isReactive(value) {
    if (isReadonly(value)) {
        return isReactive(value["__v_raw" /* RAW */]);
    }
    return !!(value && value["__v_isReactive" /* IS_REACTIVE */]);
}
function isReadonly(value) {
    return !!(value && value["__v_isReadonly" /* IS_READONLY */]);
}
function isProxy(value) {
    return isReactive(value) || isReadonly(value);
}
function toRaw(observed) {
    return ((observed && toRaw(observed["__v_raw" /* RAW */])) || observed);
}

const convert = (val) => isObject(val) ? reactive(val) : val;
function isRef(r) {
    return Boolean(r && r.__v_isRef === true);
}
function ref(value) {
    return createRef(value);
}
class RefImpl {
    constructor(_rawValue, _shallow = false) {
        this._rawValue = _rawValue;
        this._shallow = _shallow;
        this.__v_isRef = true;
        this._value = _shallow ? _rawValue : convert(_rawValue);
    }
    get value() {
        track(toRaw(this), "get" /* GET */, 'value');
        return this._value;
    }
    set value(newVal) {
        if (hasChanged(toRaw(newVal), this._rawValue)) {
            this._rawValue = newVal;
            this._value = this._shallow ? newVal : convert(newVal);
            trigger(toRaw(this), "set" /* SET */, 'value', newVal);
        }
    }
}
function createRef(rawValue, shallow = false) {
    if (isRef(rawValue)) {
        return rawValue;
    }
    return new RefImpl(rawValue, shallow);
}
function unref(ref) {
    return isRef(ref) ? ref.value : ref;
}
const shallowUnwrapHandlers = {
    get: (target, key, receiver) => unref(Reflect.get(target, key, receiver)),
    set: (target, key, value, receiver) => {
        const oldValue = target[key];
        if (isRef(oldValue) && !isRef(value)) {
            oldValue.value = value;
            return true;
        }
        else {
            return Reflect.set(target, key, value, receiver);
        }
    }
};
function proxyRefs(objectWithRefs) {
    return isReactive(objectWithRefs)
        ? objectWithRefs
        : new Proxy(objectWithRefs, shallowUnwrapHandlers);
}
class ObjectRefImpl {
    constructor(_object, _key) {
        this._object = _object;
        this._key = _key;
        this.__v_isRef = true;
    }
    get value() {
        return this._object[this._key];
    }
    set value(newVal) {
        this._object[this._key] = newVal;
    }
}
function toRef(object, key) {
    return isRef(object[key])
        ? object[key]
        : new ObjectRefImpl(object, key);
}

class ComputedRefImpl {
    constructor(getter, _setter, isReadonly) {
        this._setter = _setter;
        this._dirty = true;
        this.__v_isRef = true;
        this.effect = effect(getter, {
            lazy: true,
            scheduler: () => {
                if (!this._dirty) {
                    this._dirty = true;
                    trigger(toRaw(this), "set" /* SET */, 'value');
                }
            }
        });
        this["__v_isReadonly" /* IS_READONLY */] = isReadonly;
    }
    get value() {
        // the computed ref may get wrapped by other proxies e.g. readonly() #3376
        const self = toRaw(this);
        if (self._dirty) {
            self._value = this.effect();
            self._dirty = false;
        }
        track(self, "get" /* GET */, 'value');
        return self._value;
    }
    set value(newValue) {
        this._setter(newValue);
    }
}
function computed(getterOrOptions) {
    let getter;
    let setter;
    if (isFunction(getterOrOptions)) {
        getter = getterOrOptions;
        setter = () => {
                console.warn('Write operation failed: computed value is readonly');
            }
            ;
    }
    else {
        getter = getterOrOptions.get;
        setter = getterOrOptions.set;
    }
    return new ComputedRefImpl(getter, setter, isFunction(getterOrOptions) || !getterOrOptions.set);
}

const stack = [];
function pushWarningContext(vnode) {
    stack.push(vnode);
}
function popWarningContext() {
    stack.pop();
}
function warn(msg, ...args) {
    // avoid props formatting or warn handler tracking deps that might be mutated
    // during patch, leading to infinite recursion.
    pauseTracking();
    const instance = stack.length ? stack[stack.length - 1].component : null;
    const appWarnHandler = instance && instance.appContext.config.warnHandler;
    const trace = getComponentTrace();
    if (appWarnHandler) {
        callWithErrorHandling(appWarnHandler, instance, 11 /* APP_WARN_HANDLER */, [
            msg + args.join(''),
            instance && instance.proxy,
            trace
                .map(({ vnode }) => `at <${formatComponentName(instance, vnode.type)}>`)
                .join('\n'),
            trace
        ]);
    }
    else {
        const warnArgs = [`[Vue warn]: ${msg}`, ...args];
        /* istanbul ignore if */
        if (trace.length &&
            // avoid spamming console during tests
            !false) {
            warnArgs.push(`\n`, ...formatTrace(trace));
        }
        console.warn(...warnArgs);
    }
    resetTracking();
}
function getComponentTrace() {
    let currentVNode = stack[stack.length - 1];
    if (!currentVNode) {
        return [];
    }
    // we can't just use the stack because it will be incomplete during updates
    // that did not start from the root. Re-construct the parent chain using
    // instance parent pointers.
    const normalizedStack = [];
    while (currentVNode) {
        const last = normalizedStack[0];
        if (last && last.vnode === currentVNode) {
            last.recurseCount++;
        }
        else {
            normalizedStack.push({
                vnode: currentVNode,
                recurseCount: 0
            });
        }
        const parentInstance = currentVNode.component && currentVNode.component.parent;
        currentVNode = parentInstance && parentInstance.vnode;
    }
    return normalizedStack;
}
/* istanbul ignore next */
function formatTrace(trace) {
    const logs = [];
    trace.forEach((entry, i) => {
        logs.push(...(i === 0 ? [] : [`\n`]), ...formatTraceEntry(entry));
    });
    return logs;
}
function formatTraceEntry({ vnode, recurseCount }) {
    const postfix = recurseCount > 0 ? `... (${recurseCount} recursive calls)` : ``;
    const isRoot = vnode.component ? vnode.component.parent == null : false;
    const open = ` at <${formatComponentName(vnode.component, vnode.type, isRoot)}`;
    const close = `>` + postfix;
    return vnode.props
        ? [open, ...formatProps(vnode.props), close]
        : [open + close];
}
/* istanbul ignore next */
function formatProps(props) {
    const res = [];
    const keys = Object.keys(props);
    keys.slice(0, 3).forEach(key => {
        res.push(...formatProp(key, props[key]));
    });
    if (keys.length > 3) {
        res.push(` ...`);
    }
    return res;
}
/* istanbul ignore next */
function formatProp(key, value, raw) {
    if (isString(value)) {
        value = JSON.stringify(value);
        return raw ? value : [`${key}=${value}`];
    }
    else if (typeof value === 'number' ||
        typeof value === 'boolean' ||
        value == null) {
        return raw ? value : [`${key}=${value}`];
    }
    else if (isRef(value)) {
        value = formatProp(key, toRaw(value.value), true);
        return raw ? value : [`${key}=Ref<`, value, `>`];
    }
    else if (isFunction(value)) {
        return [`${key}=fn${value.name ? `<${value.name}>` : ``}`];
    }
    else {
        value = toRaw(value);
        return raw ? value : [`${key}=`, value];
    }
}

const ErrorTypeStrings = {
    ["bc" /* BEFORE_CREATE */]: 'beforeCreate hook',
    ["c" /* CREATED */]: 'created hook',
    ["bm" /* BEFORE_MOUNT */]: 'beforeMount hook',
    ["m" /* MOUNTED */]: 'mounted hook',
    ["bu" /* BEFORE_UPDATE */]: 'beforeUpdate hook',
    ["u" /* UPDATED */]: 'updated',
    ["bum" /* BEFORE_UNMOUNT */]: 'beforeUnmount hook',
    ["um" /* UNMOUNTED */]: 'unmounted hook',
    ["a" /* ACTIVATED */]: 'activated hook',
    ["da" /* DEACTIVATED */]: 'deactivated hook',
    ["ec" /* ERROR_CAPTURED */]: 'errorCaptured hook',
    ["rtc" /* RENDER_TRACKED */]: 'renderTracked hook',
    ["rtg" /* RENDER_TRIGGERED */]: 'renderTriggered hook',
    [0 /* SETUP_FUNCTION */]: 'setup function',
    [1 /* RENDER_FUNCTION */]: 'render function',
    [2 /* WATCH_GETTER */]: 'watcher getter',
    [3 /* WATCH_CALLBACK */]: 'watcher callback',
    [4 /* WATCH_CLEANUP */]: 'watcher cleanup function',
    [5 /* NATIVE_EVENT_HANDLER */]: 'native event handler',
    [6 /* COMPONENT_EVENT_HANDLER */]: 'component event handler',
    [7 /* VNODE_HOOK */]: 'vnode hook',
    [8 /* DIRECTIVE_HOOK */]: 'directive hook',
    [9 /* TRANSITION_HOOK */]: 'transition hook',
    [10 /* APP_ERROR_HANDLER */]: 'app errorHandler',
    [11 /* APP_WARN_HANDLER */]: 'app warnHandler',
    [12 /* FUNCTION_REF */]: 'ref function',
    [13 /* ASYNC_COMPONENT_LOADER */]: 'async component loader',
    [14 /* SCHEDULER */]: 'scheduler flush. This is likely a Vue internals bug. ' +
        'Please open an issue at https://new-issue.vuejs.org/?repo=vuejs/vue-next'
};
function callWithErrorHandling(fn, instance, type, args) {
    let res;
    try {
        res = args ? fn(...args) : fn();
    }
    catch (err) {
        handleError(err, instance, type);
    }
    return res;
}
function callWithAsyncErrorHandling(fn, instance, type, args) {
    if (isFunction(fn)) {
        const res = callWithErrorHandling(fn, instance, type, args);
        if (res && isPromise(res)) {
            res.catch(err => {
                handleError(err, instance, type);
            });
        }
        return res;
    }
    const values = [];
    for (let i = 0; i < fn.length; i++) {
        values.push(callWithAsyncErrorHandling(fn[i], instance, type, args));
    }
    return values;
}
function handleError(err, instance, type, throwInDev = true) {
    const contextVNode = instance ? instance.vnode : null;
    if (instance) {
        let cur = instance.parent;
        // the exposed instance is the render proxy to keep it consistent with 2.x
        const exposedInstance = instance.proxy;
        // in production the hook receives only the error code
        const errorInfo = ErrorTypeStrings[type] ;
        while (cur) {
            const errorCapturedHooks = cur.ec;
            if (errorCapturedHooks) {
                for (let i = 0; i < errorCapturedHooks.length; i++) {
                    if (errorCapturedHooks[i](err, exposedInstance, errorInfo) === false) {
                        return;
                    }
                }
            }
            cur = cur.parent;
        }
        // app-level handling
        const appErrorHandler = instance.appContext.config.errorHandler;
        if (appErrorHandler) {
            callWithErrorHandling(appErrorHandler, null, 10 /* APP_ERROR_HANDLER */, [err, exposedInstance, errorInfo]);
            return;
        }
    }
    logError(err, type, contextVNode, throwInDev);
}
function logError(err, type, contextVNode, throwInDev = true) {
    {
        const info = ErrorTypeStrings[type];
        if (contextVNode) {
            pushWarningContext(contextVNode);
        }
        warn(`Unhandled error${info ? ` during execution of ${info}` : ``}`);
        if (contextVNode) {
            popWarningContext();
        }
        // crash in dev by default so it's more noticeable
        if (throwInDev) {
            throw err;
        }
        else {
            console.error(err);
        }
    }
}

let isFlushing = false;
let isFlushPending = false;
const queue = [];
let flushIndex = 0;
const pendingPreFlushCbs = [];
let activePreFlushCbs = null;
let preFlushIndex = 0;
const pendingPostFlushCbs = [];
let activePostFlushCbs = null;
let postFlushIndex = 0;
const resolvedPromise = Promise.resolve();
let currentFlushPromise = null;
let currentPreFlushParentJob = null;
const RECURSION_LIMIT = 100;
function nextTick(fn) {
    const p = currentFlushPromise || resolvedPromise;
    return fn ? p.then(this ? fn.bind(this) : fn) : p;
}
// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
function findInsertionIndex(job) {
    // the start index should be `flushIndex + 1`
    let start = flushIndex + 1;
    let end = queue.length;
    const jobId = getId(job);
    while (start < end) {
        const middle = (start + end) >>> 1;
        const middleJobId = getId(queue[middle]);
        middleJobId < jobId ? (start = middle + 1) : (end = middle);
    }
    return start;
}
function queueJob(job) {
    // the dedupe search uses the startIndex argument of Array.includes()
    // by default the search index includes the current job that is being run
    // so it cannot recursively trigger itself again.
    // if the job is a watch() callback, the search will start with a +1 index to
    // allow it recursively trigger itself - it is the user's responsibility to
    // ensure it doesn't end up in an infinite loop.
    if ((!queue.length ||
        !queue.includes(job, isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex)) &&
        job !== currentPreFlushParentJob) {
        const pos = findInsertionIndex(job);
        if (pos > -1) {
            queue.splice(pos, 0, job);
        }
        else {
            queue.push(job);
        }
        queueFlush();
    }
}
function queueFlush() {
    if (!isFlushing && !isFlushPending) {
        isFlushPending = true;
        currentFlushPromise = resolvedPromise.then(flushJobs);
    }
}
function invalidateJob(job) {
    const i = queue.indexOf(job);
    if (i > flushIndex) {
        queue.splice(i, 1);
    }
}
function queueCb(cb, activeQueue, pendingQueue, index) {
    if (!isArray(cb)) {
        if (!activeQueue ||
            !activeQueue.includes(cb, cb.allowRecurse ? index + 1 : index)) {
            pendingQueue.push(cb);
        }
    }
    else {
        // if cb is an array, it is a component lifecycle hook which can only be
        // triggered by a job, which is already deduped in the main queue, so
        // we can skip duplicate check here to improve perf
        pendingQueue.push(...cb);
    }
    queueFlush();
}
function queuePreFlushCb(cb) {
    queueCb(cb, activePreFlushCbs, pendingPreFlushCbs, preFlushIndex);
}
function queuePostFlushCb(cb) {
    queueCb(cb, activePostFlushCbs, pendingPostFlushCbs, postFlushIndex);
}
function flushPreFlushCbs(seen, parentJob = null) {
    if (pendingPreFlushCbs.length) {
        currentPreFlushParentJob = parentJob;
        activePreFlushCbs = [...new Set(pendingPreFlushCbs)];
        pendingPreFlushCbs.length = 0;
        {
            seen = seen || new Map();
        }
        for (preFlushIndex = 0; preFlushIndex < activePreFlushCbs.length; preFlushIndex++) {
            {
                checkRecursiveUpdates(seen, activePreFlushCbs[preFlushIndex]);
            }
            activePreFlushCbs[preFlushIndex]();
        }
        activePreFlushCbs = null;
        preFlushIndex = 0;
        currentPreFlushParentJob = null;
        // recursively flush until it drains
        flushPreFlushCbs(seen, parentJob);
    }
}
function flushPostFlushCbs(seen) {
    if (pendingPostFlushCbs.length) {
        const deduped = [...new Set(pendingPostFlushCbs)];
        pendingPostFlushCbs.length = 0;
        // #1947 already has active queue, nested flushPostFlushCbs call
        if (activePostFlushCbs) {
            activePostFlushCbs.push(...deduped);
            return;
        }
        activePostFlushCbs = deduped;
        {
            seen = seen || new Map();
        }
        activePostFlushCbs.sort((a, b) => getId(a) - getId(b));
        for (postFlushIndex = 0; postFlushIndex < activePostFlushCbs.length; postFlushIndex++) {
            {
                checkRecursiveUpdates(seen, activePostFlushCbs[postFlushIndex]);
            }
            activePostFlushCbs[postFlushIndex]();
        }
        activePostFlushCbs = null;
        postFlushIndex = 0;
    }
}
const getId = (job) => job.id == null ? Infinity : job.id;
function flushJobs(seen) {
    isFlushPending = false;
    isFlushing = true;
    {
        seen = seen || new Map();
    }
    flushPreFlushCbs(seen);
    // Sort queue before flush.
    // This ensures that:
    // 1. Components are updated from parent to child. (because parent is always
    //    created before the child so its render effect will have smaller
    //    priority number)
    // 2. If a component is unmounted during a parent component's update,
    //    its update can be skipped.
    queue.sort((a, b) => getId(a) - getId(b));
    try {
        for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
            const job = queue[flushIndex];
            if (job) {
                if (true) {
                    checkRecursiveUpdates(seen, job);
                }
                callWithErrorHandling(job, null, 14 /* SCHEDULER */);
            }
        }
    }
    finally {
        flushIndex = 0;
        queue.length = 0;
        flushPostFlushCbs(seen);
        isFlushing = false;
        currentFlushPromise = null;
        // some postFlushCb queued jobs!
        // keep flushing until it drains.
        if (queue.length || pendingPostFlushCbs.length) {
            flushJobs(seen);
        }
    }
}
function checkRecursiveUpdates(seen, fn) {
    if (!seen.has(fn)) {
        seen.set(fn, 1);
    }
    else {
        const count = seen.get(fn);
        if (count > RECURSION_LIMIT) {
            throw new Error(`Maximum recursive updates exceeded. ` +
                `This means you have a reactive effect that is mutating its own ` +
                `dependencies and thus recursively triggering itself. Possible sources ` +
                `include component template, render function, updated hook or ` +
                `watcher source function.`);
        }
        else {
            seen.set(fn, count + 1);
        }
    }
}

/* eslint-disable no-restricted-globals */
let isHmrUpdating = false;
const hmrDirtyComponents = new Set();
// Expose the HMR runtime on the global object
// This makes it entirely tree-shakable without polluting the exports and makes
// it easier to be used in toolings like vue-loader
// Note: for a component to be eligible for HMR it also needs the __hmrId option
// to be set so that its instances can be registered / removed.
{
    const globalObject = typeof global !== 'undefined'
        ? global
        : typeof self !== 'undefined'
            ? self
            : typeof window !== 'undefined'
                ? window
                : {};
    globalObject.__VUE_HMR_RUNTIME__ = {
        createRecord: tryWrap(createRecord),
        rerender: tryWrap(rerender),
        reload: tryWrap(reload)
    };
}
const map = new Map();
function registerHMR(instance) {
    const id = instance.type.__hmrId;
    let record = map.get(id);
    if (!record) {
        createRecord(id, instance.type);
        record = map.get(id);
    }
    record.instances.add(instance);
}
function unregisterHMR(instance) {
    map.get(instance.type.__hmrId).instances.delete(instance);
}
function createRecord(id, component) {
    if (!component) {
        warn(`HMR API usage is out of date.\n` +
            `Please upgrade vue-loader/vite/rollup-plugin-vue or other relevant ` +
            `dependency that handles Vue SFC compilation.`);
        component = {};
    }
    if (map.has(id)) {
        return false;
    }
    map.set(id, {
        component: isClassComponent(component) ? component.__vccOpts : component,
        instances: new Set()
    });
    return true;
}
function rerender(id, newRender) {
    const record = map.get(id);
    if (!record)
        return;
    if (newRender)
        record.component.render = newRender;
    // Array.from creates a snapshot which avoids the set being mutated during
    // updates
    Array.from(record.instances).forEach(instance => {
        if (newRender) {
            instance.render = newRender;
        }
        instance.renderCache = [];
        // this flag forces child components with slot content to update
        isHmrUpdating = true;
        instance.update();
        isHmrUpdating = false;
    });
}
function reload(id, newComp) {
    const record = map.get(id);
    if (!record)
        return;
    // Array.from creates a snapshot which avoids the set being mutated during
    // updates
    const { component, instances } = record;
    if (!hmrDirtyComponents.has(component)) {
        // 1. Update existing comp definition to match new one
        newComp = isClassComponent(newComp) ? newComp.__vccOpts : newComp;
        extend(component, newComp);
        for (const key in component) {
            if (!(key in newComp)) {
                delete component[key];
            }
        }
        // 2. Mark component dirty. This forces the renderer to replace the component
        // on patch.
        hmrDirtyComponents.add(component);
        // 3. Make sure to unmark the component after the reload.
        queuePostFlushCb(() => {
            hmrDirtyComponents.delete(component);
        });
    }
    Array.from(instances).forEach(instance => {
        if (instance.parent) {
            // 4. Force the parent instance to re-render. This will cause all updated
            // components to be unmounted and re-mounted. Queue the update so that we
            // don't end up forcing the same parent to re-render multiple times.
            queueJob(instance.parent.update);
        }
        else if (instance.appContext.reload) {
            // root instance mounted via createApp() has a reload method
            instance.appContext.reload();
        }
        else if (typeof window !== 'undefined') {
            // root instance inside tree created via raw render(). Force reload.
            window.location.reload();
        }
        else {
            console.warn('[HMR] Root or manually mounted instance modified. Full reload required.');
        }
    });
}
function tryWrap(fn) {
    return (id, arg) => {
        try {
            return fn(id, arg);
        }
        catch (e) {
            console.error(e);
            console.warn(`[HMR] Something went wrong during Vue component hot-reload. ` +
                `Full reload required.`);
        }
    };
}

let devtools;
function setDevtoolsHook(hook) {
    devtools = hook;
}
function devtoolsInitApp(app, version) {
    // TODO queue if devtools is undefined
    if (!devtools)
        return;
    devtools.emit("app:init" /* APP_INIT */, app, version, {
        Fragment,
        Text,
        Comment,
        Static
    });
}
function devtoolsUnmountApp(app) {
    if (!devtools)
        return;
    devtools.emit("app:unmount" /* APP_UNMOUNT */, app);
}
const devtoolsComponentAdded = /*#__PURE__*/ createDevtoolsComponentHook("component:added" /* COMPONENT_ADDED */);
const devtoolsComponentUpdated = /*#__PURE__*/ createDevtoolsComponentHook("component:updated" /* COMPONENT_UPDATED */);
const devtoolsComponentRemoved = /*#__PURE__*/ createDevtoolsComponentHook("component:removed" /* COMPONENT_REMOVED */);
function createDevtoolsComponentHook(hook) {
    return (component) => {
        if (!devtools)
            return;
        devtools.emit(hook, component.appContext.app, component.uid, component.parent ? component.parent.uid : undefined, component);
    };
}
function devtoolsComponentEmit(component, event, params) {
    if (!devtools)
        return;
    devtools.emit("component:emit" /* COMPONENT_EMIT */, component.appContext.app, component, event, params);
}

function emit(instance, event, ...rawArgs) {
    const props = instance.vnode.props || EMPTY_OBJ;
    {
        const { emitsOptions, propsOptions: [propsOptions] } = instance;
        if (emitsOptions) {
            if (!(event in emitsOptions)) {
                if (!propsOptions || !(toHandlerKey(event) in propsOptions)) {
                    warn(`Component emitted event "${event}" but it is neither declared in ` +
                        `the emits option nor as an "${toHandlerKey(event)}" prop.`);
                }
            }
            else {
                const validator = emitsOptions[event];
                if (isFunction(validator)) {
                    const isValid = validator(...rawArgs);
                    if (!isValid) {
                        warn(`Invalid event arguments: event validation failed for event "${event}".`);
                    }
                }
            }
        }
    }
    let args = rawArgs;
    const isModelListener = event.startsWith('update:');
    // for v-model update:xxx events, apply modifiers on args
    const modelArg = isModelListener && event.slice(7);
    if (modelArg && modelArg in props) {
        const modifiersKey = `${modelArg === 'modelValue' ? 'model' : modelArg}Modifiers`;
        const { number, trim } = props[modifiersKey] || EMPTY_OBJ;
        if (trim) {
            args = rawArgs.map(a => a.trim());
        }
        else if (number) {
            args = rawArgs.map(toNumber);
        }
    }
    {
        devtoolsComponentEmit(instance, event, args);
    }
    {
        const lowerCaseEvent = event.toLowerCase();
        if (lowerCaseEvent !== event && props[toHandlerKey(lowerCaseEvent)]) {
            warn(`Event "${lowerCaseEvent}" is emitted in component ` +
                `${formatComponentName(instance, instance.type)} but the handler is registered for "${event}". ` +
                `Note that HTML attributes are case-insensitive and you cannot use ` +
                `v-on to listen to camelCase events when using in-DOM templates. ` +
                `You should probably use "${hyphenate(event)}" instead of "${event}".`);
        }
    }
    let handlerName;
    let handler = props[(handlerName = toHandlerKey(event))] ||
        // also try camelCase event handler (#2249)
        props[(handlerName = toHandlerKey(camelize(event)))];
    // for v-model update:xxx events, also trigger kebab-case equivalent
    // for props passed via kebab-case
    if (!handler && isModelListener) {
        handler = props[(handlerName = toHandlerKey(hyphenate(event)))];
    }
    if (handler) {
        callWithAsyncErrorHandling(handler, instance, 6 /* COMPONENT_EVENT_HANDLER */, args);
    }
    const onceHandler = props[handlerName + `Once`];
    if (onceHandler) {
        if (!instance.emitted) {
            (instance.emitted = {})[handlerName] = true;
        }
        else if (instance.emitted[handlerName]) {
            return;
        }
        callWithAsyncErrorHandling(onceHandler, instance, 6 /* COMPONENT_EVENT_HANDLER */, args);
    }
}
function normalizeEmitsOptions(comp, appContext, asMixin = false) {
    if (!appContext.deopt && comp.__emits !== undefined) {
        return comp.__emits;
    }
    const raw = comp.emits;
    let normalized = {};
    // apply mixin/extends props
    let hasExtends = false;
    if (!isFunction(comp)) {
        const extendEmits = (raw) => {
            const normalizedFromExtend = normalizeEmitsOptions(raw, appContext, true);
            if (normalizedFromExtend) {
                hasExtends = true;
                extend(normalized, normalizedFromExtend);
            }
        };
        if (!asMixin && appContext.mixins.length) {
            appContext.mixins.forEach(extendEmits);
        }
        if (comp.extends) {
            extendEmits(comp.extends);
        }
        if (comp.mixins) {
            comp.mixins.forEach(extendEmits);
        }
    }
    if (!raw && !hasExtends) {
        return (comp.__emits = null);
    }
    if (isArray(raw)) {
        raw.forEach(key => (normalized[key] = null));
    }
    else {
        extend(normalized, raw);
    }
    return (comp.__emits = normalized);
}
// Check if an incoming prop key is a declared emit event listener.
// e.g. With `emits: { click: null }`, props named `onClick` and `onclick` are
// both considered matched listeners.
function isEmitListener(options, key) {
    if (!options || !isOn(key)) {
        return false;
    }
    key = key.slice(2).replace(/Once$/, '');
    return (hasOwn(options, key[0].toLowerCase() + key.slice(1)) ||
        hasOwn(options, hyphenate(key)) ||
        hasOwn(options, key));
}

let isRenderingCompiledSlot = 0;
const setCompiledSlotRendering = (n) => (isRenderingCompiledSlot += n);

/**
 * mark the current rendering instance for asset resolution (e.g.
 * resolveComponent, resolveDirective) during render
 */
let currentRenderingInstance = null;
let currentScopeId = null;
/**
 * Note: rendering calls maybe nested. The function returns the parent rendering
 * instance if present, which should be restored after the render is done:
 *
 * ```js
 * const prev = setCurrentRenderingInstance(i)
 * // ...render
 * setCurrentRenderingInstance(prev)
 * ```
 */
function setCurrentRenderingInstance(instance) {
    const prev = currentRenderingInstance;
    currentRenderingInstance = instance;
    currentScopeId = (instance && instance.type.__scopeId) || null;
    return prev;
}
/**
 * Wrap a slot function to memoize current rendering instance
 * @private compiler helper
 */
function withCtx(fn, ctx = currentRenderingInstance) {
    if (!ctx)
        return fn;
    const renderFnWithContext = (...args) => {
        // If a user calls a compiled slot inside a template expression (#1745), it
        // can mess up block tracking, so by default we need to push a null block to
        // avoid that. This isn't necessary if rendering a compiled `<slot>`.
        if (!isRenderingCompiledSlot) {
            openBlock(true /* null block that disables tracking */);
        }
        const prevInstance = setCurrentRenderingInstance(ctx);
        const res = fn(...args);
        setCurrentRenderingInstance(prevInstance);
        if (!isRenderingCompiledSlot) {
            closeBlock();
        }
        return res;
    };
    // mark this as a compiled slot function.
    // this is used in vnode.ts -> normalizeChildren() to set the slot
    // rendering flag.
    renderFnWithContext._c = true;
    return renderFnWithContext;
}

/**
 * dev only flag to track whether $attrs was used during render.
 * If $attrs was used during render then the warning for failed attrs
 * fallthrough can be suppressed.
 */
let accessedAttrs = false;
function markAttrsAccessed() {
    accessedAttrs = true;
}
function renderComponentRoot(instance) {
    const { type: Component, vnode, proxy, withProxy, props, propsOptions: [propsOptions], slots, attrs, emit, render, renderCache, data, setupState, ctx } = instance;
    let result;
    const prev = setCurrentRenderingInstance(instance);
    {
        accessedAttrs = false;
    }
    try {
        let fallthroughAttrs;
        if (vnode.shapeFlag & 4 /* STATEFUL_COMPONENT */) {
            // withProxy is a proxy with a different `has` trap only for
            // runtime-compiled render functions using `with` block.
            const proxyToUse = withProxy || proxy;
            result = normalizeVNode(render.call(proxyToUse, proxyToUse, renderCache, props, setupState, data, ctx));
            fallthroughAttrs = attrs;
        }
        else {
            // functional
            const render = Component;
            // in dev, mark attrs accessed if optional props (attrs === props)
            if (true && attrs === props) {
                markAttrsAccessed();
            }
            result = normalizeVNode(render.length > 1
                ? render(props, true
                    ? {
                        get attrs() {
                            markAttrsAccessed();
                            return attrs;
                        },
                        slots,
                        emit
                    }
                    : { attrs, slots, emit })
                : render(props, null /* we know it doesn't need it */));
            fallthroughAttrs = Component.props
                ? attrs
                : getFunctionalFallthrough(attrs);
        }
        // attr merging
        // in dev mode, comments are preserved, and it's possible for a template
        // to have comments along side the root element which makes it a fragment
        let root = result;
        let setRoot = undefined;
        if (true &&
            result.patchFlag > 0 &&
            result.patchFlag & 2048 /* DEV_ROOT_FRAGMENT */) {
            ;
            [root, setRoot] = getChildRoot(result);
        }
        if (Component.inheritAttrs !== false && fallthroughAttrs) {
            const keys = Object.keys(fallthroughAttrs);
            const { shapeFlag } = root;
            if (keys.length) {
                if (shapeFlag & 1 /* ELEMENT */ ||
                    shapeFlag & 6 /* COMPONENT */) {
                    if (propsOptions && keys.some(isModelListener)) {
                        // If a v-model listener (onUpdate:xxx) has a corresponding declared
                        // prop, it indicates this component expects to handle v-model and
                        // it should not fallthrough.
                        // related: #1543, #1643, #1989
                        fallthroughAttrs = filterModelListeners(fallthroughAttrs, propsOptions);
                    }
                    root = cloneVNode(root, fallthroughAttrs);
                }
                else if (true && !accessedAttrs && root.type !== Comment) {
                    const allAttrs = Object.keys(attrs);
                    const eventAttrs = [];
                    const extraAttrs = [];
                    for (let i = 0, l = allAttrs.length; i < l; i++) {
                        const key = allAttrs[i];
                        if (isOn(key)) {
                            // ignore v-model handlers when they fail to fallthrough
                            if (!isModelListener(key)) {
                                // remove `on`, lowercase first letter to reflect event casing
                                // accurately
                                eventAttrs.push(key[2].toLowerCase() + key.slice(3));
                            }
                        }
                        else {
                            extraAttrs.push(key);
                        }
                    }
                    if (extraAttrs.length) {
                        warn(`Extraneous non-props attributes (` +
                            `${extraAttrs.join(', ')}) ` +
                            `were passed to component but could not be automatically inherited ` +
                            `because component renders fragment or text root nodes.`);
                    }
                    if (eventAttrs.length) {
                        warn(`Extraneous non-emits event listeners (` +
                            `${eventAttrs.join(', ')}) ` +
                            `were passed to component but could not be automatically inherited ` +
                            `because component renders fragment or text root nodes. ` +
                            `If the listener is intended to be a component custom event listener only, ` +
                            `declare it using the "emits" option.`);
                    }
                }
            }
        }
        // inherit directives
        if (vnode.dirs) {
            if (true && !isElementRoot(root)) {
                warn(`Runtime directive used on component with non-element root node. ` +
                    `The directives will not function as intended.`);
            }
            root.dirs = root.dirs ? root.dirs.concat(vnode.dirs) : vnode.dirs;
        }
        // inherit transition data
        if (vnode.transition) {
            if (true && !isElementRoot(root)) {
                warn(`Component inside <Transition> renders non-element root node ` +
                    `that cannot be animated.`);
            }
            root.transition = vnode.transition;
        }
        if (true && setRoot) {
            setRoot(root);
        }
        else {
            result = root;
        }
    }
    catch (err) {
        blockStack.length = 0;
        handleError(err, instance, 1 /* RENDER_FUNCTION */);
        result = createVNode(Comment);
    }
    setCurrentRenderingInstance(prev);
    return result;
}
/**
 * dev only
 * In dev mode, template root level comments are rendered, which turns the
 * template into a fragment root, but we need to locate the single element
 * root for attrs and scope id processing.
 */
const getChildRoot = (vnode) => {
    const rawChildren = vnode.children;
    const dynamicChildren = vnode.dynamicChildren;
    const childRoot = filterSingleRoot(rawChildren);
    if (!childRoot) {
        return [vnode, undefined];
    }
    const index = rawChildren.indexOf(childRoot);
    const dynamicIndex = dynamicChildren ? dynamicChildren.indexOf(childRoot) : -1;
    const setRoot = (updatedRoot) => {
        rawChildren[index] = updatedRoot;
        if (dynamicChildren) {
            if (dynamicIndex > -1) {
                dynamicChildren[dynamicIndex] = updatedRoot;
            }
            else if (updatedRoot.patchFlag > 0) {
                vnode.dynamicChildren = [...dynamicChildren, updatedRoot];
            }
        }
    };
    return [normalizeVNode(childRoot), setRoot];
};
function filterSingleRoot(children) {
    let singleRoot;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (isVNode(child)) {
            // ignore user comment
            if (child.type !== Comment || child.children === 'v-if') {
                if (singleRoot) {
                    // has more than 1 non-comment child, return now
                    return;
                }
                else {
                    singleRoot = child;
                }
            }
        }
        else {
            return;
        }
    }
    return singleRoot;
}
const getFunctionalFallthrough = (attrs) => {
    let res;
    for (const key in attrs) {
        if (key === 'class' || key === 'style' || isOn(key)) {
            (res || (res = {}))[key] = attrs[key];
        }
    }
    return res;
};
const filterModelListeners = (attrs, props) => {
    const res = {};
    for (const key in attrs) {
        if (!isModelListener(key) || !(key.slice(9) in props)) {
            res[key] = attrs[key];
        }
    }
    return res;
};
const isElementRoot = (vnode) => {
    return (vnode.shapeFlag & 6 /* COMPONENT */ ||
        vnode.shapeFlag & 1 /* ELEMENT */ ||
        vnode.type === Comment // potential v-if branch switch
    );
};
function shouldUpdateComponent(prevVNode, nextVNode, optimized) {
    const { props: prevProps, children: prevChildren, component } = prevVNode;
    const { props: nextProps, children: nextChildren, patchFlag } = nextVNode;
    const emits = component.emitsOptions;
    // Parent component's render function was hot-updated. Since this may have
    // caused the child component's slots content to have changed, we need to
    // force the child to update as well.
    if ((prevChildren || nextChildren) && isHmrUpdating) {
        return true;
    }
    // force child update for runtime directive or transition on component vnode.
    if (nextVNode.dirs || nextVNode.transition) {
        return true;
    }
    if (optimized && patchFlag >= 0) {
        if (patchFlag & 1024 /* DYNAMIC_SLOTS */) {
            // slot content that references values that might have changed,
            // e.g. in a v-for
            return true;
        }
        if (patchFlag & 16 /* FULL_PROPS */) {
            if (!prevProps) {
                return !!nextProps;
            }
            // presence of this flag indicates props are always non-null
            return hasPropsChanged(prevProps, nextProps, emits);
        }
        else if (patchFlag & 8 /* PROPS */) {
            const dynamicProps = nextVNode.dynamicProps;
            for (let i = 0; i < dynamicProps.length; i++) {
                const key = dynamicProps[i];
                if (nextProps[key] !== prevProps[key] &&
                    !isEmitListener(emits, key)) {
                    return true;
                }
            }
        }
    }
    else {
        // this path is only taken by manually written render functions
        // so presence of any children leads to a forced update
        if (prevChildren || nextChildren) {
            if (!nextChildren || !nextChildren.$stable) {
                return true;
            }
        }
        if (prevProps === nextProps) {
            return false;
        }
        if (!prevProps) {
            return !!nextProps;
        }
        if (!nextProps) {
            return true;
        }
        return hasPropsChanged(prevProps, nextProps, emits);
    }
    return false;
}
function hasPropsChanged(prevProps, nextProps, emitsOptions) {
    const nextKeys = Object.keys(nextProps);
    if (nextKeys.length !== Object.keys(prevProps).length) {
        return true;
    }
    for (let i = 0; i < nextKeys.length; i++) {
        const key = nextKeys[i];
        if (nextProps[key] !== prevProps[key] &&
            !isEmitListener(emitsOptions, key)) {
            return true;
        }
    }
    return false;
}
function updateHOCHostEl({ vnode, parent }, el // HostNode
) {
    while (parent && parent.subTree === vnode) {
        (vnode = parent.vnode).el = el;
        parent = parent.parent;
    }
}

const isSuspense = (type) => type.__isSuspense;
function normalizeSuspenseChildren(vnode) {
    const { shapeFlag, children } = vnode;
    let content;
    let fallback;
    if (shapeFlag & 32 /* SLOTS_CHILDREN */) {
        content = normalizeSuspenseSlot(children.default);
        fallback = normalizeSuspenseSlot(children.fallback);
    }
    else {
        content = normalizeSuspenseSlot(children);
        fallback = normalizeVNode(null);
    }
    return {
        content,
        fallback
    };
}
function normalizeSuspenseSlot(s) {
    if (isFunction(s)) {
        s = s();
    }
    if (isArray(s)) {
        const singleChild = filterSingleRoot(s);
        if (!singleChild) {
            warn(`<Suspense> slots expect a single root node.`);
        }
        s = singleChild;
    }
    return normalizeVNode(s);
}
function queueEffectWithSuspense(fn, suspense) {
    if (suspense && suspense.pendingBranch) {
        if (isArray(fn)) {
            suspense.effects.push(...fn);
        }
        else {
            suspense.effects.push(fn);
        }
    }
    else {
        queuePostFlushCb(fn);
    }
}

function initProps(instance, rawProps, isStateful, // result of bitwise flag comparison
isSSR = false) {
    const props = {};
    const attrs = {};
    def(attrs, InternalObjectKey, 1);
    instance.propsDefaults = Object.create(null);
    setFullProps(instance, rawProps, props, attrs);
    // ensure all declared prop keys are present
    for (const key in instance.propsOptions[0]) {
        if (!(key in props)) {
            props[key] = undefined;
        }
    }
    // validation
    {
        validateProps(rawProps || {}, props, instance);
    }
    if (isStateful) {
        // stateful
        instance.props = isSSR ? props : shallowReactive(props);
    }
    else {
        if (!instance.type.props) {
            // functional w/ optional props, props === attrs
            instance.props = attrs;
        }
        else {
            // functional w/ declared props
            instance.props = props;
        }
    }
    instance.attrs = attrs;
}
function updateProps(instance, rawProps, rawPrevProps, optimized) {
    const { props, attrs, vnode: { patchFlag } } = instance;
    const rawCurrentProps = toRaw(props);
    const [options] = instance.propsOptions;
    if (
    // always force full diff in dev
    // - #1942 if hmr is enabled with sfc component
    // - vite#872 non-sfc component used by sfc component
    !((instance.type.__hmrId ||
            (instance.parent && instance.parent.type.__hmrId))) &&
        (optimized || patchFlag > 0) &&
        !(patchFlag & 16 /* FULL_PROPS */)) {
        if (patchFlag & 8 /* PROPS */) {
            // Compiler-generated props & no keys change, just set the updated
            // the props.
            const propsToUpdate = instance.vnode.dynamicProps;
            for (let i = 0; i < propsToUpdate.length; i++) {
                const key = propsToUpdate[i];
                // PROPS flag guarantees rawProps to be non-null
                const value = rawProps[key];
                if (options) {
                    // attr / props separation was done on init and will be consistent
                    // in this code path, so just check if attrs have it.
                    if (hasOwn(attrs, key)) {
                        attrs[key] = value;
                    }
                    else {
                        const camelizedKey = camelize(key);
                        props[camelizedKey] = resolvePropValue(options, rawCurrentProps, camelizedKey, value, instance);
                    }
                }
                else {
                    attrs[key] = value;
                }
            }
        }
    }
    else {
        // full props update.
        setFullProps(instance, rawProps, props, attrs);
        // in case of dynamic props, check if we need to delete keys from
        // the props object
        let kebabKey;
        for (const key in rawCurrentProps) {
            if (!rawProps ||
                // for camelCase
                (!hasOwn(rawProps, key) &&
                    // it's possible the original props was passed in as kebab-case
                    // and converted to camelCase (#955)
                    ((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey)))) {
                if (options) {
                    if (rawPrevProps &&
                        // for camelCase
                        (rawPrevProps[key] !== undefined ||
                            // for kebab-case
                            rawPrevProps[kebabKey] !== undefined)) {
                        props[key] = resolvePropValue(options, rawProps || EMPTY_OBJ, key, undefined, instance);
                    }
                }
                else {
                    delete props[key];
                }
            }
        }
        // in the case of functional component w/o props declaration, props and
        // attrs point to the same object so it should already have been updated.
        if (attrs !== rawCurrentProps) {
            for (const key in attrs) {
                if (!rawProps || !hasOwn(rawProps, key)) {
                    delete attrs[key];
                }
            }
        }
    }
    // trigger updates for $attrs in case it's used in component slots
    trigger(instance, "set" /* SET */, '$attrs');
    {
        validateProps(rawProps || {}, props, instance);
    }
}
function setFullProps(instance, rawProps, props, attrs) {
    const [options, needCastKeys] = instance.propsOptions;
    if (rawProps) {
        for (const key in rawProps) {
            // key, ref are reserved and never passed down
            if (isReservedProp(key)) {
                continue;
            }
            const value = rawProps[key];
            // prop option names are camelized during normalization, so to support
            // kebab -> camel conversion here we need to camelize the key.
            let camelKey;
            if (options && hasOwn(options, (camelKey = camelize(key)))) {
                props[camelKey] = value;
            }
            else if (!isEmitListener(instance.emitsOptions, key)) {
                // Any non-declared (either as a prop or an emitted event) props are put
                // into a separate `attrs` object for spreading. Make sure to preserve
                // original key casing
                attrs[key] = value;
            }
        }
    }
    if (needCastKeys) {
        const rawCurrentProps = toRaw(props);
        for (let i = 0; i < needCastKeys.length; i++) {
            const key = needCastKeys[i];
            props[key] = resolvePropValue(options, rawCurrentProps, key, rawCurrentProps[key], instance);
        }
    }
}
function resolvePropValue(options, props, key, value, instance) {
    const opt = options[key];
    if (opt != null) {
        const hasDefault = hasOwn(opt, 'default');
        // default values
        if (hasDefault && value === undefined) {
            const defaultValue = opt.default;
            if (opt.type !== Function && isFunction(defaultValue)) {
                const { propsDefaults } = instance;
                if (key in propsDefaults) {
                    value = propsDefaults[key];
                }
                else {
                    setCurrentInstance(instance);
                    value = propsDefaults[key] = defaultValue(props);
                    setCurrentInstance(null);
                }
            }
            else {
                value = defaultValue;
            }
        }
        // boolean casting
        if (opt[0 /* shouldCast */]) {
            if (!hasOwn(props, key) && !hasDefault) {
                value = false;
            }
            else if (opt[1 /* shouldCastTrue */] &&
                (value === '' || value === hyphenate(key))) {
                value = true;
            }
        }
    }
    return value;
}
function normalizePropsOptions(comp, appContext, asMixin = false) {
    if (!appContext.deopt && comp.__props) {
        return comp.__props;
    }
    const raw = comp.props;
    const normalized = {};
    const needCastKeys = [];
    // apply mixin/extends props
    let hasExtends = false;
    if (!isFunction(comp)) {
        const extendProps = (raw) => {
            hasExtends = true;
            const [props, keys] = normalizePropsOptions(raw, appContext, true);
            extend(normalized, props);
            if (keys)
                needCastKeys.push(...keys);
        };
        if (!asMixin && appContext.mixins.length) {
            appContext.mixins.forEach(extendProps);
        }
        if (comp.extends) {
            extendProps(comp.extends);
        }
        if (comp.mixins) {
            comp.mixins.forEach(extendProps);
        }
    }
    if (!raw && !hasExtends) {
        return (comp.__props = EMPTY_ARR);
    }
    if (isArray(raw)) {
        for (let i = 0; i < raw.length; i++) {
            if (!isString(raw[i])) {
                warn(`props must be strings when using array syntax.`, raw[i]);
            }
            const normalizedKey = camelize(raw[i]);
            if (validatePropName(normalizedKey)) {
                normalized[normalizedKey] = EMPTY_OBJ;
            }
        }
    }
    else if (raw) {
        if (!isObject(raw)) {
            warn(`invalid props options`, raw);
        }
        for (const key in raw) {
            const normalizedKey = camelize(key);
            if (validatePropName(normalizedKey)) {
                const opt = raw[key];
                const prop = (normalized[normalizedKey] =
                    isArray(opt) || isFunction(opt) ? { type: opt } : opt);
                if (prop) {
                    const booleanIndex = getTypeIndex(Boolean, prop.type);
                    const stringIndex = getTypeIndex(String, prop.type);
                    prop[0 /* shouldCast */] = booleanIndex > -1;
                    prop[1 /* shouldCastTrue */] =
                        stringIndex < 0 || booleanIndex < stringIndex;
                    // if the prop needs boolean casting or default value
                    if (booleanIndex > -1 || hasOwn(prop, 'default')) {
                        needCastKeys.push(normalizedKey);
                    }
                }
            }
        }
    }
    return (comp.__props = [normalized, needCastKeys]);
}
function validatePropName(key) {
    if (key[0] !== '$') {
        return true;
    }
    else {
        warn(`Invalid prop name: "${key}" is a reserved property.`);
    }
    return false;
}
// use function string name to check type constructors
// so that it works across vms / iframes.
function getType(ctor) {
    const match = ctor && ctor.toString().match(/^\s*function (\w+)/);
    return match ? match[1] : '';
}
function isSameType(a, b) {
    return getType(a) === getType(b);
}
function getTypeIndex(type, expectedTypes) {
    if (isArray(expectedTypes)) {
        return expectedTypes.findIndex(t => isSameType(t, type));
    }
    else if (isFunction(expectedTypes)) {
        return isSameType(expectedTypes, type) ? 0 : -1;
    }
    return -1;
}
/**
 * dev only
 */
function validateProps(rawProps, props, instance) {
    const resolvedValues = toRaw(props);
    const options = instance.propsOptions[0];
    for (const key in options) {
        let opt = options[key];
        if (opt == null)
            continue;
        validateProp(key, resolvedValues[key], opt, !hasOwn(rawProps, key) && !hasOwn(rawProps, hyphenate(key)));
    }
}
/**
 * dev only
 */
function validateProp(name, value, prop, isAbsent) {
    const { type, required, validator } = prop;
    // required!
    if (required && isAbsent) {
        warn('Missing required prop: "' + name + '"');
        return;
    }
    // missing but optional
    if (value == null && !prop.required) {
        return;
    }
    // type check
    if (type != null && type !== true) {
        let isValid = false;
        const types = isArray(type) ? type : [type];
        const expectedTypes = [];
        // value is valid as long as one of the specified types match
        for (let i = 0; i < types.length && !isValid; i++) {
            const { valid, expectedType } = assertType(value, types[i]);
            expectedTypes.push(expectedType || '');
            isValid = valid;
        }
        if (!isValid) {
            warn(getInvalidTypeMessage(name, value, expectedTypes));
            return;
        }
    }
    // custom validator
    if (validator && !validator(value)) {
        warn('Invalid prop: custom validator check failed for prop "' + name + '".');
    }
}
const isSimpleType = /*#__PURE__*/ makeMap('String,Number,Boolean,Function,Symbol,BigInt');
/**
 * dev only
 */
function assertType(value, type) {
    let valid;
    const expectedType = getType(type);
    if (isSimpleType(expectedType)) {
        const t = typeof value;
        valid = t === expectedType.toLowerCase();
        // for primitive wrapper objects
        if (!valid && t === 'object') {
            valid = value instanceof type;
        }
    }
    else if (expectedType === 'Object') {
        valid = isObject(value);
    }
    else if (expectedType === 'Array') {
        valid = isArray(value);
    }
    else {
        valid = value instanceof type;
    }
    return {
        valid,
        expectedType
    };
}
/**
 * dev only
 */
function getInvalidTypeMessage(name, value, expectedTypes) {
    let message = `Invalid prop: type check failed for prop "${name}".` +
        ` Expected ${expectedTypes.map(capitalize).join(', ')}`;
    const expectedType = expectedTypes[0];
    const receivedType = toRawType(value);
    const expectedValue = styleValue(value, expectedType);
    const receivedValue = styleValue(value, receivedType);
    // check if we need to specify expected value
    if (expectedTypes.length === 1 &&
        isExplicable(expectedType) &&
        !isBoolean(expectedType, receivedType)) {
        message += ` with value ${expectedValue}`;
    }
    message += `, got ${receivedType} `;
    // check if we need to specify received value
    if (isExplicable(receivedType)) {
        message += `with value ${receivedValue}.`;
    }
    return message;
}
/**
 * dev only
 */
function styleValue(value, type) {
    if (type === 'String') {
        return `"${value}"`;
    }
    else if (type === 'Number') {
        return `${Number(value)}`;
    }
    else {
        return `${value}`;
    }
}
/**
 * dev only
 */
function isExplicable(type) {
    const explicitTypes = ['string', 'number', 'boolean'];
    return explicitTypes.some(elem => type.toLowerCase() === elem);
}
/**
 * dev only
 */
function isBoolean(...args) {
    return args.some(elem => elem.toLowerCase() === 'boolean');
}

function injectHook(type, hook, target = currentInstance, prepend = false) {
    if (target) {
        const hooks = target[type] || (target[type] = []);
        // cache the error handling wrapper for injected hooks so the same hook
        // can be properly deduped by the scheduler. "__weh" stands for "with error
        // handling".
        const wrappedHook = hook.__weh ||
            (hook.__weh = (...args) => {
                if (target.isUnmounted) {
                    return;
                }
                // disable tracking inside all lifecycle hooks
                // since they can potentially be called inside effects.
                pauseTracking();
                // Set currentInstance during hook invocation.
                // This assumes the hook does not synchronously trigger other hooks, which
                // can only be false when the user does something really funky.
                setCurrentInstance(target);
                const res = callWithAsyncErrorHandling(hook, target, type, args);
                setCurrentInstance(null);
                resetTracking();
                return res;
            });
        if (prepend) {
            hooks.unshift(wrappedHook);
        }
        else {
            hooks.push(wrappedHook);
        }
        return wrappedHook;
    }
    else {
        const apiName = toHandlerKey(ErrorTypeStrings[type].replace(/ hook$/, ''));
        warn(`${apiName} is called when there is no active component instance to be ` +
            `associated with. ` +
            `Lifecycle injection APIs can only be used during execution of setup().` +
            (` If you are using async setup(), make sure to register lifecycle ` +
                    `hooks before the first await statement.`
                ));
    }
}
const createHook = (lifecycle) => (hook, target = currentInstance) => 
// post-create lifecycle registrations are noops during SSR
!isInSSRComponentSetup && injectHook(lifecycle, hook, target);
const onBeforeMount = createHook("bm" /* BEFORE_MOUNT */);
const onMounted = createHook("m" /* MOUNTED */);
const onBeforeUpdate = createHook("bu" /* BEFORE_UPDATE */);
const onUpdated = createHook("u" /* UPDATED */);
const onBeforeUnmount = createHook("bum" /* BEFORE_UNMOUNT */);
const onUnmounted = createHook("um" /* UNMOUNTED */);
const onRenderTriggered = createHook("rtg" /* RENDER_TRIGGERED */);
const onRenderTracked = createHook("rtc" /* RENDER_TRACKED */);
const onErrorCaptured = (hook, target = currentInstance) => {
    injectHook("ec" /* ERROR_CAPTURED */, hook, target);
};

// Simple effect.
function watchEffect(effect, options) {
    return doWatch(effect, null, options);
}
// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {};
// implementation
function watch(source, cb, options) {
    if (!isFunction(cb)) {
        warn(`\`watch(fn, options?)\` signature has been moved to a separate API. ` +
            `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
            `supports \`watch(source, cb, options?) signature.`);
    }
    return doWatch(source, cb, options);
}
function doWatch(source, cb, { immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ, instance = currentInstance) {
    if (!cb) {
        if (immediate !== undefined) {
            warn(`watch() "immediate" option is only respected when using the ` +
                `watch(source, callback, options?) signature.`);
        }
        if (deep !== undefined) {
            warn(`watch() "deep" option is only respected when using the ` +
                `watch(source, callback, options?) signature.`);
        }
    }
    const warnInvalidSource = (s) => {
        warn(`Invalid watch source: `, s, `A watch source can only be a getter/effect function, a ref, ` +
            `a reactive object, or an array of these types.`);
    };
    let getter;
    let forceTrigger = false;
    if (isRef(source)) {
        getter = () => source.value;
        forceTrigger = !!source._shallow;
    }
    else if (isReactive(source)) {
        getter = () => source;
        deep = true;
    }
    else if (isArray(source)) {
        getter = () => source.map(s => {
            if (isRef(s)) {
                return s.value;
            }
            else if (isReactive(s)) {
                return traverse(s);
            }
            else if (isFunction(s)) {
                return callWithErrorHandling(s, instance, 2 /* WATCH_GETTER */, [
                    instance && instance.proxy
                ]);
            }
            else {
                warnInvalidSource(s);
            }
        });
    }
    else if (isFunction(source)) {
        if (cb) {
            // getter with cb
            getter = () => callWithErrorHandling(source, instance, 2 /* WATCH_GETTER */, [
                instance && instance.proxy
            ]);
        }
        else {
            // no cb -> simple effect
            getter = () => {
                if (instance && instance.isUnmounted) {
                    return;
                }
                if (cleanup) {
                    cleanup();
                }
                return callWithAsyncErrorHandling(source, instance, 3 /* WATCH_CALLBACK */, [onInvalidate]);
            };
        }
    }
    else {
        getter = NOOP;
        warnInvalidSource(source);
    }
    if (cb && deep) {
        const baseGetter = getter;
        getter = () => traverse(baseGetter());
    }
    let cleanup;
    let onInvalidate = (fn) => {
        cleanup = runner.options.onStop = () => {
            callWithErrorHandling(fn, instance, 4 /* WATCH_CLEANUP */);
        };
    };
    // in SSR there is no need to setup an actual effect, and it should be noop
    // unless it's eager
    if (isInSSRComponentSetup) {
        // we will also not call the invalidate callback (+ runner is not set up)
        onInvalidate = NOOP;
        if (!cb) {
            getter();
        }
        else if (immediate) {
            callWithAsyncErrorHandling(cb, instance, 3 /* WATCH_CALLBACK */, [
                getter(),
                undefined,
                onInvalidate
            ]);
        }
        return NOOP;
    }
    let oldValue = isArray(source) ? [] : INITIAL_WATCHER_VALUE;
    const job = () => {
        if (!runner.active) {
            return;
        }
        if (cb) {
            // watch(source, cb)
            const newValue = runner();
            if (deep || forceTrigger || hasChanged(newValue, oldValue)) {
                // cleanup before running cb again
                if (cleanup) {
                    cleanup();
                }
                callWithAsyncErrorHandling(cb, instance, 3 /* WATCH_CALLBACK */, [
                    newValue,
                    // pass undefined as the old value when it's changed for the first time
                    oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
                    onInvalidate
                ]);
                oldValue = newValue;
            }
        }
        else {
            // watchEffect
            runner();
        }
    };
    // important: mark the job as a watcher callback so that scheduler knows
    // it is allowed to self-trigger (#1727)
    job.allowRecurse = !!cb;
    let scheduler;
    if (flush === 'sync') {
        scheduler = job;
    }
    else if (flush === 'post') {
        scheduler = () => queuePostRenderEffect(job, instance && instance.suspense);
    }
    else {
        // default: 'pre'
        scheduler = () => {
            if (!instance || instance.isMounted) {
                queuePreFlushCb(job);
            }
            else {
                // with 'pre' option, the first call must happen before
                // the component is mounted so it is called synchronously.
                job();
            }
        };
    }
    const runner = effect(getter, {
        lazy: true,
        onTrack,
        onTrigger,
        scheduler
    });
    recordInstanceBoundEffect(runner, instance);
    // initial run
    if (cb) {
        if (immediate) {
            job();
        }
        else {
            oldValue = runner();
        }
    }
    else if (flush === 'post') {
        queuePostRenderEffect(runner, instance && instance.suspense);
    }
    else {
        runner();
    }
    return () => {
        stop(runner);
        if (instance) {
            remove(instance.effects, runner);
        }
    };
}
// this.$watch
function instanceWatch(source, cb, options) {
    const publicThis = this.proxy;
    const getter = isString(source)
        ? source.includes('.')
            ? createPathGetter(publicThis, source)
            : () => publicThis[source]
        : source.bind(publicThis);
    return doWatch(getter, cb.bind(publicThis), options, this);
}
function createPathGetter(ctx, path) {
    const segments = path.split('.');
    return () => {
        let cur = ctx;
        for (let i = 0; i < segments.length && cur; i++) {
            cur = cur[segments[i]];
        }
        return cur;
    };
}
function traverse(value, seen = new Set()) {
    if (!isObject(value) || seen.has(value)) {
        return value;
    }
    seen.add(value);
    if (isRef(value)) {
        traverse(value.value, seen);
    }
    else if (isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            traverse(value[i], seen);
        }
    }
    else if (isSet(value) || isMap(value)) {
        value.forEach((v) => {
            traverse(v, seen);
        });
    }
    else {
        for (const key in value) {
            traverse(value[key], seen);
        }
    }
    return value;
}

const isKeepAlive = (vnode) => vnode.type.__isKeepAlive;
function onActivated(hook, target) {
    registerKeepAliveHook(hook, "a" /* ACTIVATED */, target);
}
function onDeactivated(hook, target) {
    registerKeepAliveHook(hook, "da" /* DEACTIVATED */, target);
}
function registerKeepAliveHook(hook, type, target = currentInstance) {
    // cache the deactivate branch check wrapper for injected hooks so the same
    // hook can be properly deduped by the scheduler. "__wdc" stands for "with
    // deactivation check".
    const wrappedHook = hook.__wdc ||
        (hook.__wdc = () => {
            // only fire the hook if the target instance is NOT in a deactivated branch.
            let current = target;
            while (current) {
                if (current.isDeactivated) {
                    return;
                }
                current = current.parent;
            }
            hook();
        });
    injectHook(type, wrappedHook, target);
    // In addition to registering it on the target instance, we walk up the parent
    // chain and register it on all ancestor instances that are keep-alive roots.
    // This avoids the need to walk the entire component tree when invoking these
    // hooks, and more importantly, avoids the need to track child components in
    // arrays.
    if (target) {
        let current = target.parent;
        while (current && current.parent) {
            if (isKeepAlive(current.parent.vnode)) {
                injectToKeepAliveRoot(wrappedHook, type, target, current);
            }
            current = current.parent;
        }
    }
}
function injectToKeepAliveRoot(hook, type, target, keepAliveRoot) {
    // injectHook wraps the original for error handling, so make sure to remove
    // the wrapped version.
    const injected = injectHook(type, hook, keepAliveRoot, true /* prepend */);
    onUnmounted(() => {
        remove(keepAliveRoot[type], injected);
    }, target);
}

const isInternalKey = (key) => key[0] === '_' || key === '$stable';
const normalizeSlotValue = (value) => isArray(value)
    ? value.map(normalizeVNode)
    : [normalizeVNode(value)];
const normalizeSlot = (key, rawSlot, ctx) => withCtx((props) => {
    if (currentInstance) {
        warn(`Slot "${key}" invoked outside of the render function: ` +
            `this will not track dependencies used in the slot. ` +
            `Invoke the slot function inside the render function instead.`);
    }
    return normalizeSlotValue(rawSlot(props));
}, ctx);
const normalizeObjectSlots = (rawSlots, slots) => {
    const ctx = rawSlots._ctx;
    for (const key in rawSlots) {
        if (isInternalKey(key))
            continue;
        const value = rawSlots[key];
        if (isFunction(value)) {
            slots[key] = normalizeSlot(key, value, ctx);
        }
        else if (value != null) {
            {
                warn(`Non-function value encountered for slot "${key}". ` +
                    `Prefer function slots for better performance.`);
            }
            const normalized = normalizeSlotValue(value);
            slots[key] = () => normalized;
        }
    }
};
const normalizeVNodeSlots = (instance, children) => {
    if (!isKeepAlive(instance.vnode)) {
        warn(`Non-function value encountered for default slot. ` +
            `Prefer function slots for better performance.`);
    }
    const normalized = normalizeSlotValue(children);
    instance.slots.default = () => normalized;
};
const initSlots = (instance, children) => {
    if (instance.vnode.shapeFlag & 32 /* SLOTS_CHILDREN */) {
        const type = children._;
        if (type) {
            instance.slots = children;
            // make compiler marker non-enumerable
            def(children, '_', type);
        }
        else {
            normalizeObjectSlots(children, (instance.slots = {}));
        }
    }
    else {
        instance.slots = {};
        if (children) {
            normalizeVNodeSlots(instance, children);
        }
    }
    def(instance.slots, InternalObjectKey, 1);
};
const updateSlots = (instance, children, optimized) => {
    const { vnode, slots } = instance;
    let needDeletionCheck = true;
    let deletionComparisonTarget = EMPTY_OBJ;
    if (vnode.shapeFlag & 32 /* SLOTS_CHILDREN */) {
        const type = children._;
        if (type) {
            // compiled slots.
            if (isHmrUpdating) {
                // Parent was HMR updated so slot content may have changed.
                // force update slots and mark instance for hmr as well
                extend(slots, children);
            }
            else if (optimized && type === 1 /* STABLE */) {
                // compiled AND stable.
                // no need to update, and skip stale slots removal.
                needDeletionCheck = false;
            }
            else {
                // compiled but dynamic (v-if/v-for on slots) - update slots, but skip
                // normalization.
                extend(slots, children);
                // #2893
                // when rendering the optimized slots by manually written render function,
                // we need to delete the `slots._` flag if necessary to make subsequent updates reliable,
                // i.e. let the `renderSlot` create the bailed Fragment
                if (!optimized && type === 1 /* STABLE */) {
                    delete slots._;
                }
            }
        }
        else {
            needDeletionCheck = !children.$stable;
            normalizeObjectSlots(children, slots);
        }
        deletionComparisonTarget = children;
    }
    else if (children) {
        // non slot object children (direct value) passed to a component
        normalizeVNodeSlots(instance, children);
        deletionComparisonTarget = { default: 1 };
    }
    // delete stale slots
    if (needDeletionCheck) {
        for (const key in slots) {
            if (!isInternalKey(key) && !(key in deletionComparisonTarget)) {
                delete slots[key];
            }
        }
    }
};

/**
Runtime helper for applying directives to a vnode. Example usage:

const comp = resolveComponent('comp')
const foo = resolveDirective('foo')
const bar = resolveDirective('bar')

return withDirectives(h(comp), [
  [foo, this.x],
  [bar, this.y]
])
*/
const isBuiltInDirective = /*#__PURE__*/ makeMap('bind,cloak,else-if,else,for,html,if,model,on,once,pre,show,slot,text');
function validateDirectiveName(name) {
    if (isBuiltInDirective(name)) {
        warn('Do not use built-in directive ids as custom directive id: ' + name);
    }
}
function invokeDirectiveHook(vnode, prevVNode, instance, name) {
    const bindings = vnode.dirs;
    const oldBindings = prevVNode && prevVNode.dirs;
    for (let i = 0; i < bindings.length; i++) {
        const binding = bindings[i];
        if (oldBindings) {
            binding.oldValue = oldBindings[i].value;
        }
        const hook = binding.dir[name];
        if (hook) {
            callWithAsyncErrorHandling(hook, instance, 8 /* DIRECTIVE_HOOK */, [
                vnode.el,
                binding,
                vnode,
                prevVNode
            ]);
        }
    }
}

function createAppContext() {
    return {
        app: null,
        config: {
            isNativeTag: NO,
            performance: false,
            globalProperties: {},
            optionMergeStrategies: {},
            isCustomElement: NO,
            errorHandler: undefined,
            warnHandler: undefined
        },
        mixins: [],
        components: {},
        directives: {},
        provides: Object.create(null)
    };
}
let uid$1 = 0;
function createAppAPI(render, hydrate) {
    return function createApp(rootComponent, rootProps = null) {
        if (rootProps != null && !isObject(rootProps)) {
            warn(`root props passed to app.mount() must be an object.`);
            rootProps = null;
        }
        const context = createAppContext();
        const installedPlugins = new Set();
        let isMounted = false;
        const app = (context.app = {
            _uid: uid$1++,
            _component: rootComponent,
            _props: rootProps,
            _container: null,
            _context: context,
            version,
            get config() {
                return context.config;
            },
            set config(v) {
                {
                    warn(`app.config cannot be replaced. Modify individual options instead.`);
                }
            },
            use(plugin, ...options) {
                if (installedPlugins.has(plugin)) {
                    warn(`Plugin has already been applied to target app.`);
                }
                else if (plugin && isFunction(plugin.install)) {
                    installedPlugins.add(plugin);
                    plugin.install(app, ...options);
                }
                else if (isFunction(plugin)) {
                    installedPlugins.add(plugin);
                    plugin(app, ...options);
                }
                else {
                    warn(`A plugin must either be a function or an object with an "install" ` +
                        `function.`);
                }
                return app;
            },
            mixin(mixin) {
                {
                    if (!context.mixins.includes(mixin)) {
                        context.mixins.push(mixin);
                        // global mixin with props/emits de-optimizes props/emits
                        // normalization caching.
                        if (mixin.props || mixin.emits) {
                            context.deopt = true;
                        }
                    }
                    else {
                        warn('Mixin has already been applied to target app' +
                            (mixin.name ? `: ${mixin.name}` : ''));
                    }
                }
                return app;
            },
            component(name, component) {
                {
                    validateComponentName(name, context.config);
                }
                if (!component) {
                    return context.components[name];
                }
                if (context.components[name]) {
                    warn(`Component "${name}" has already been registered in target app.`);
                }
                context.components[name] = component;
                return app;
            },
            directive(name, directive) {
                {
                    validateDirectiveName(name);
                }
                if (!directive) {
                    return context.directives[name];
                }
                if (context.directives[name]) {
                    warn(`Directive "${name}" has already been registered in target app.`);
                }
                context.directives[name] = directive;
                return app;
            },
            mount(rootContainer, isHydrate, isSVG) {
                if (!isMounted) {
                    const vnode = createVNode(rootComponent, rootProps);
                    // store app context on the root VNode.
                    // this will be set on the root instance on initial mount.
                    vnode.appContext = context;
                    // HMR root reload
                    {
                        context.reload = () => {
                            render(cloneVNode(vnode), rootContainer, isSVG);
                        };
                    }
                    if (isHydrate && hydrate) {
                        hydrate(vnode, rootContainer);
                    }
                    else {
                        render(vnode, rootContainer, isSVG);
                    }
                    isMounted = true;
                    app._container = rootContainer;
                    rootContainer.__vue_app__ = app;
                    {
                        devtoolsInitApp(app, version);
                    }
                    return vnode.component.proxy;
                }
                else {
                    warn(`App has already been mounted.\n` +
                        `If you want to remount the same app, move your app creation logic ` +
                        `into a factory function and create fresh app instances for each ` +
                        `mount - e.g. \`const createMyApp = () => createApp(App)\``);
                }
            },
            unmount() {
                if (isMounted) {
                    render(null, app._container);
                    {
                        devtoolsUnmountApp(app);
                    }
                    delete app._container.__vue_app__;
                }
                else {
                    warn(`Cannot unmount an app that is not mounted.`);
                }
            },
            provide(key, value) {
                if (key in context.provides) {
                    warn(`App already provides property with key "${String(key)}". ` +
                        `It will be overwritten with the new value.`);
                }
                // TypeScript doesn't allow symbols as index type
                // https://github.com/Microsoft/TypeScript/issues/24587
                context.provides[key] = value;
                return app;
            }
        });
        return app;
    };
}

let supported;
let perf;
function startMeasure(instance, type) {
    if (instance.appContext.config.performance && isSupported()) {
        perf.mark(`vue-${type}-${instance.uid}`);
    }
}
function endMeasure(instance, type) {
    if (instance.appContext.config.performance && isSupported()) {
        const startTag = `vue-${type}-${instance.uid}`;
        const endTag = startTag + `:end`;
        perf.mark(endTag);
        perf.measure(`<${formatComponentName(instance, instance.type)}> ${type}`, startTag, endTag);
        perf.clearMarks(startTag);
        perf.clearMarks(endTag);
    }
}
function isSupported() {
    if (supported !== undefined) {
        return supported;
    }
    /* eslint-disable no-restricted-globals */
    if (typeof window !== 'undefined' && window.performance) {
        supported = true;
        perf = window.performance;
    }
    else {
        supported = false;
    }
    /* eslint-enable no-restricted-globals */
    return supported;
}

const isAsyncWrapper = (i) => !!i.type.__asyncLoader;

function createDevEffectOptions(instance) {
    return {
        scheduler: queueJob,
        allowRecurse: true,
        onTrack: instance.rtc ? e => invokeArrayFns(instance.rtc, e) : void 0,
        onTrigger: instance.rtg ? e => invokeArrayFns(instance.rtg, e) : void 0
    };
}
const queuePostRenderEffect = queueEffectWithSuspense
    ;
const setRef = (rawRef, oldRawRef, parentSuspense, vnode) => {
    if (isArray(rawRef)) {
        rawRef.forEach((r, i) => setRef(r, oldRawRef && (isArray(oldRawRef) ? oldRawRef[i] : oldRawRef), parentSuspense, vnode));
        return;
    }
    let value;
    if (!vnode) {
        // means unmount
        value = null;
    }
    else if (isAsyncWrapper(vnode)) {
        // when mounting async components, nothing needs to be done,
        // because the template ref is forwarded to inner component
        return;
    }
    else if (vnode.shapeFlag & 4 /* STATEFUL_COMPONENT */) {
        value = vnode.component.exposed || vnode.component.proxy;
    }
    else {
        value = vnode.el;
    }
    const { i: owner, r: ref } = rawRef;
    if (!owner) {
        warn(`Missing ref owner context. ref cannot be used on hoisted vnodes. ` +
            `A vnode with ref must be created inside the render function.`);
        return;
    }
    const oldRef = oldRawRef && oldRawRef.r;
    const refs = owner.refs === EMPTY_OBJ ? (owner.refs = {}) : owner.refs;
    const setupState = owner.setupState;
    // unset old ref
    if (oldRef != null && oldRef !== ref) {
        if (isString(oldRef)) {
            refs[oldRef] = null;
            if (hasOwn(setupState, oldRef)) {
                setupState[oldRef] = null;
            }
        }
        else if (isRef(oldRef)) {
            oldRef.value = null;
        }
    }
    if (isString(ref)) {
        const doSet = () => {
            refs[ref] = value;
            if (hasOwn(setupState, ref)) {
                setupState[ref] = value;
            }
        };
        // #1789: for non-null values, set them after render
        // null values means this is unmount and it should not overwrite another
        // ref with the same key
        if (value) {
            doSet.id = -1;
            queuePostRenderEffect(doSet, parentSuspense);
        }
        else {
            doSet();
        }
    }
    else if (isRef(ref)) {
        const doSet = () => {
            ref.value = value;
        };
        if (value) {
            doSet.id = -1;
            queuePostRenderEffect(doSet, parentSuspense);
        }
        else {
            doSet();
        }
    }
    else if (isFunction(ref)) {
        callWithErrorHandling(ref, owner, 12 /* FUNCTION_REF */, [value, refs]);
    }
    else {
        warn('Invalid template ref type:', value, `(${typeof value})`);
    }
};
/**
 * The createRenderer function accepts two generic arguments:
 * HostNode and HostElement, corresponding to Node and Element types in the
 * host environment. For example, for runtime-dom, HostNode would be the DOM
 * `Node` interface and HostElement would be the DOM `Element` interface.
 *
 * Custom renderers can pass in the platform specific types like this:
 *
 * ``` js
 * const { render, createApp } = createRenderer<Node, Element>({
 *   patchProp,
 *   ...nodeOps
 * })
 * ```
 */
function createRenderer(options) {
    return baseCreateRenderer(options);
}
// implementation
function baseCreateRenderer(options, createHydrationFns) {
    {
        const target = getGlobalThis();
        target.__VUE__ = true;
        setDevtoolsHook(target.__VUE_DEVTOOLS_GLOBAL_HOOK__);
    }
    const { insert: hostInsert, remove: hostRemove, patchProp: hostPatchProp, forcePatchProp: hostForcePatchProp, createElement: hostCreateElement, createText: hostCreateText, createComment: hostCreateComment, setText: hostSetText, setElementText: hostSetElementText, parentNode: hostParentNode, nextSibling: hostNextSibling, setScopeId: hostSetScopeId = NOOP, cloneNode: hostCloneNode, insertStaticContent: hostInsertStaticContent } = options;
    // Note: functions inside this closure should use `const xxx = () => {}`
    // style in order to prevent being inlined by minifiers.
    const patch = (n1, n2, container, anchor = null, parentComponent = null, parentSuspense = null, isSVG = false, slotScopeIds = null, optimized = false) => {
        // patching & not same type, unmount old tree
        if (n1 && !isSameVNodeType(n1, n2)) {
            anchor = getNextHostNode(n1);
            unmount(n1, parentComponent, parentSuspense, true);
            n1 = null;
        }
        if (n2.patchFlag === -2 /* BAIL */) {
            optimized = false;
            n2.dynamicChildren = null;
        }
        const { type, ref, shapeFlag } = n2;
        switch (type) {
            case Text:
                processText(n1, n2, container, anchor);
                break;
            case Comment:
                processCommentNode(n1, n2, container, anchor);
                break;
            case Static:
                if (n1 == null) {
                    mountStaticNode(n2, container, anchor, isSVG);
                }
                else {
                    patchStaticNode(n1, n2, container, isSVG);
                }
                break;
            case Fragment:
                processFragment(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
                break;
            default:
                if (shapeFlag & 1 /* ELEMENT */) {
                    processElement(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
                }
                else if (shapeFlag & 6 /* COMPONENT */) {
                    processComponent(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
                }
                else if (shapeFlag & 64 /* TELEPORT */) {
                    type.process(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized, internals);
                }
                else if (shapeFlag & 128 /* SUSPENSE */) {
                    type.process(n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized, internals);
                }
                else {
                    warn('Invalid VNode type:', type, `(${typeof type})`);
                }
        }
        // set ref
        if (ref != null && parentComponent) {
            setRef(ref, n1 && n1.ref, parentSuspense, n2);
        }
    };
    const processText = (n1, n2, container, anchor) => {
        if (n1 == null) {
            hostInsert((n2.el = hostCreateText(n2.children)), container, anchor);
        }
        else {
            const el = (n2.el = n1.el);
            if (n2.children !== n1.children) {
                hostSetText(el, n2.children);
            }
        }
    };
    const processCommentNode = (n1, n2, container, anchor) => {
        if (n1 == null) {
            hostInsert((n2.el = hostCreateComment(n2.children || '')), container, anchor);
        }
        else {
            // there's no support for dynamic comments
            n2.el = n1.el;
        }
    };
    const mountStaticNode = (n2, container, anchor, isSVG) => {
        [n2.el, n2.anchor] = hostInsertStaticContent(n2.children, container, anchor, isSVG);
    };
    /**
     * Dev / HMR only
     */
    const patchStaticNode = (n1, n2, container, isSVG) => {
        // static nodes are only patched during dev for HMR
        if (n2.children !== n1.children) {
            const anchor = hostNextSibling(n1.anchor);
            // remove existing
            removeStaticNode(n1);
            [n2.el, n2.anchor] = hostInsertStaticContent(n2.children, container, anchor, isSVG);
        }
        else {
            n2.el = n1.el;
            n2.anchor = n1.anchor;
        }
    };
    const moveStaticNode = ({ el, anchor }, container, nextSibling) => {
        let next;
        while (el && el !== anchor) {
            next = hostNextSibling(el);
            hostInsert(el, container, nextSibling);
            el = next;
        }
        hostInsert(anchor, container, nextSibling);
    };
    const removeStaticNode = ({ el, anchor }) => {
        let next;
        while (el && el !== anchor) {
            next = hostNextSibling(el);
            hostRemove(el);
            el = next;
        }
        hostRemove(anchor);
    };
    const processElement = (n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized) => {
        isSVG = isSVG || n2.type === 'svg';
        if (n1 == null) {
            mountElement(n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
        }
        else {
            patchElement(n1, n2, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
        }
    };
    const mountElement = (vnode, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized) => {
        let el;
        let vnodeHook;
        const { type, props, shapeFlag, transition, patchFlag, dirs } = vnode;
        {
            el = vnode.el = hostCreateElement(vnode.type, isSVG, props && props.is, props);
            // mount children first, since some props may rely on child content
            // being already rendered, e.g. `<select value>`
            if (shapeFlag & 8 /* TEXT_CHILDREN */) {
                hostSetElementText(el, vnode.children);
            }
            else if (shapeFlag & 16 /* ARRAY_CHILDREN */) {
                mountChildren(vnode.children, el, null, parentComponent, parentSuspense, isSVG && type !== 'foreignObject', slotScopeIds, optimized || !!vnode.dynamicChildren);
            }
            if (dirs) {
                invokeDirectiveHook(vnode, null, parentComponent, 'created');
            }
            // props
            if (props) {
                for (const key in props) {
                    if (!isReservedProp(key)) {
                        hostPatchProp(el, key, null, props[key], isSVG, vnode.children, parentComponent, parentSuspense, unmountChildren);
                    }
                }
                if ((vnodeHook = props.onVnodeBeforeMount)) {
                    invokeVNodeHook(vnodeHook, parentComponent, vnode);
                }
            }
            // scopeId
            setScopeId(el, vnode, vnode.scopeId, slotScopeIds, parentComponent);
        }
        {
            Object.defineProperty(el, '__vnode', {
                value: vnode,
                enumerable: false
            });
            Object.defineProperty(el, '__vueParentComponent', {
                value: parentComponent,
                enumerable: false
            });
        }
        if (dirs) {
            invokeDirectiveHook(vnode, null, parentComponent, 'beforeMount');
        }
        // #1583 For inside suspense + suspense not resolved case, enter hook should call when suspense resolved
        // #1689 For inside suspense + suspense resolved case, just call it
        const needCallTransitionHooks = (!parentSuspense || (parentSuspense && !parentSuspense.pendingBranch)) &&
            transition &&
            !transition.persisted;
        if (needCallTransitionHooks) {
            transition.beforeEnter(el);
        }
        hostInsert(el, container, anchor);
        if ((vnodeHook = props && props.onVnodeMounted) ||
            needCallTransitionHooks ||
            dirs) {
            queuePostRenderEffect(() => {
                vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode);
                needCallTransitionHooks && transition.enter(el);
                dirs && invokeDirectiveHook(vnode, null, parentComponent, 'mounted');
            }, parentSuspense);
        }
    };
    const setScopeId = (el, vnode, scopeId, slotScopeIds, parentComponent) => {
        if (scopeId) {
            hostSetScopeId(el, scopeId);
        }
        if (slotScopeIds) {
            for (let i = 0; i < slotScopeIds.length; i++) {
                hostSetScopeId(el, slotScopeIds[i]);
            }
        }
        if (parentComponent) {
            let subTree = parentComponent.subTree;
            if (subTree.patchFlag > 0 &&
                subTree.patchFlag & 2048 /* DEV_ROOT_FRAGMENT */) {
                subTree =
                    filterSingleRoot(subTree.children) || subTree;
            }
            if (vnode === subTree) {
                const parentVNode = parentComponent.vnode;
                setScopeId(el, parentVNode, parentVNode.scopeId, parentVNode.slotScopeIds, parentComponent.parent);
            }
        }
    };
    const mountChildren = (children, container, anchor, parentComponent, parentSuspense, isSVG, optimized, slotScopeIds, start = 0) => {
        for (let i = start; i < children.length; i++) {
            const child = (children[i] = optimized
                ? cloneIfMounted(children[i])
                : normalizeVNode(children[i]));
            patch(null, child, container, anchor, parentComponent, parentSuspense, isSVG, optimized, slotScopeIds);
        }
    };
    const patchElement = (n1, n2, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized) => {
        const el = (n2.el = n1.el);
        let { patchFlag, dynamicChildren, dirs } = n2;
        // #1426 take the old vnode's patch flag into account since user may clone a
        // compiler-generated vnode, which de-opts to FULL_PROPS
        patchFlag |= n1.patchFlag & 16 /* FULL_PROPS */;
        const oldProps = n1.props || EMPTY_OBJ;
        const newProps = n2.props || EMPTY_OBJ;
        let vnodeHook;
        if ((vnodeHook = newProps.onVnodeBeforeUpdate)) {
            invokeVNodeHook(vnodeHook, parentComponent, n2, n1);
        }
        if (dirs) {
            invokeDirectiveHook(n2, n1, parentComponent, 'beforeUpdate');
        }
        if (isHmrUpdating) {
            // HMR updated, force full diff
            patchFlag = 0;
            optimized = false;
            dynamicChildren = null;
        }
        if (patchFlag > 0) {
            // the presence of a patchFlag means this element's render code was
            // generated by the compiler and can take the fast path.
            // in this path old node and new node are guaranteed to have the same shape
            // (i.e. at the exact same position in the source template)
            if (patchFlag & 16 /* FULL_PROPS */) {
                // element props contain dynamic keys, full diff needed
                patchProps(el, n2, oldProps, newProps, parentComponent, parentSuspense, isSVG);
            }
            else {
                // class
                // this flag is matched when the element has dynamic class bindings.
                if (patchFlag & 2 /* CLASS */) {
                    if (oldProps.class !== newProps.class) {
                        hostPatchProp(el, 'class', null, newProps.class, isSVG);
                    }
                }
                // style
                // this flag is matched when the element has dynamic style bindings
                if (patchFlag & 4 /* STYLE */) {
                    hostPatchProp(el, 'style', oldProps.style, newProps.style, isSVG);
                }
                // props
                // This flag is matched when the element has dynamic prop/attr bindings
                // other than class and style. The keys of dynamic prop/attrs are saved for
                // faster iteration.
                // Note dynamic keys like :[foo]="bar" will cause this optimization to
                // bail out and go through a full diff because we need to unset the old key
                if (patchFlag & 8 /* PROPS */) {
                    // if the flag is present then dynamicProps must be non-null
                    const propsToUpdate = n2.dynamicProps;
                    for (let i = 0; i < propsToUpdate.length; i++) {
                        const key = propsToUpdate[i];
                        const prev = oldProps[key];
                        const next = newProps[key];
                        if (next !== prev ||
                            (hostForcePatchProp && hostForcePatchProp(el, key))) {
                            hostPatchProp(el, key, prev, next, isSVG, n1.children, parentComponent, parentSuspense, unmountChildren);
                        }
                    }
                }
            }
            // text
            // This flag is matched when the element has only dynamic text children.
            if (patchFlag & 1 /* TEXT */) {
                if (n1.children !== n2.children) {
                    hostSetElementText(el, n2.children);
                }
            }
        }
        else if (!optimized && dynamicChildren == null) {
            // unoptimized, full diff
            patchProps(el, n2, oldProps, newProps, parentComponent, parentSuspense, isSVG);
        }
        const areChildrenSVG = isSVG && n2.type !== 'foreignObject';
        if (dynamicChildren) {
            patchBlockChildren(n1.dynamicChildren, dynamicChildren, el, parentComponent, parentSuspense, areChildrenSVG, slotScopeIds);
            if (parentComponent && parentComponent.type.__hmrId) {
                traverseStaticChildren(n1, n2);
            }
        }
        else if (!optimized) {
            // full diff
            patchChildren(n1, n2, el, null, parentComponent, parentSuspense, areChildrenSVG, slotScopeIds, false);
        }
        if ((vnodeHook = newProps.onVnodeUpdated) || dirs) {
            queuePostRenderEffect(() => {
                vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, n2, n1);
                dirs && invokeDirectiveHook(n2, n1, parentComponent, 'updated');
            }, parentSuspense);
        }
    };
    // The fast path for blocks.
    const patchBlockChildren = (oldChildren, newChildren, fallbackContainer, parentComponent, parentSuspense, isSVG, slotScopeIds) => {
        for (let i = 0; i < newChildren.length; i++) {
            const oldVNode = oldChildren[i];
            const newVNode = newChildren[i];
            // Determine the container (parent element) for the patch.
            const container = 
            // - In the case of a Fragment, we need to provide the actual parent
            // of the Fragment itself so it can move its children.
            oldVNode.type === Fragment ||
                // - In the case of different nodes, there is going to be a replacement
                // which also requires the correct parent container
                !isSameVNodeType(oldVNode, newVNode) ||
                // - In the case of a component, it could contain anything.
                oldVNode.shapeFlag & 6 /* COMPONENT */ ||
                oldVNode.shapeFlag & 64 /* TELEPORT */
                ? hostParentNode(oldVNode.el)
                : // In other cases, the parent container is not actually used so we
                    // just pass the block element here to avoid a DOM parentNode call.
                    fallbackContainer;
            patch(oldVNode, newVNode, container, null, parentComponent, parentSuspense, isSVG, slotScopeIds, true);
        }
    };
    const patchProps = (el, vnode, oldProps, newProps, parentComponent, parentSuspense, isSVG) => {
        if (oldProps !== newProps) {
            for (const key in newProps) {
                // empty string is not valid prop
                if (isReservedProp(key))
                    continue;
                const next = newProps[key];
                const prev = oldProps[key];
                if (next !== prev ||
                    (hostForcePatchProp && hostForcePatchProp(el, key))) {
                    hostPatchProp(el, key, prev, next, isSVG, vnode.children, parentComponent, parentSuspense, unmountChildren);
                }
            }
            if (oldProps !== EMPTY_OBJ) {
                for (const key in oldProps) {
                    if (!isReservedProp(key) && !(key in newProps)) {
                        hostPatchProp(el, key, oldProps[key], null, isSVG, vnode.children, parentComponent, parentSuspense, unmountChildren);
                    }
                }
            }
        }
    };
    const processFragment = (n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized) => {
        const fragmentStartAnchor = (n2.el = n1 ? n1.el : hostCreateText(''));
        const fragmentEndAnchor = (n2.anchor = n1 ? n1.anchor : hostCreateText(''));
        let { patchFlag, dynamicChildren, slotScopeIds: fragmentSlotScopeIds } = n2;
        if (patchFlag > 0) {
            optimized = true;
        }
        // check if this is a slot fragment with :slotted scope ids
        if (fragmentSlotScopeIds) {
            slotScopeIds = slotScopeIds
                ? slotScopeIds.concat(fragmentSlotScopeIds)
                : fragmentSlotScopeIds;
        }
        if (isHmrUpdating) {
            // HMR updated, force full diff
            patchFlag = 0;
            optimized = false;
            dynamicChildren = null;
        }
        if (n1 == null) {
            hostInsert(fragmentStartAnchor, container, anchor);
            hostInsert(fragmentEndAnchor, container, anchor);
            // a fragment can only have array children
            // since they are either generated by the compiler, or implicitly created
            // from arrays.
            mountChildren(n2.children, container, fragmentEndAnchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
        }
        else {
            if (patchFlag > 0 &&
                patchFlag & 64 /* STABLE_FRAGMENT */ &&
                dynamicChildren &&
                // #2715 the previous fragment could've been a BAILed one as a result
                // of renderSlot() with no valid children
                n1.dynamicChildren) {
                // a stable fragment (template root or <template v-for>) doesn't need to
                // patch children order, but it may contain dynamicChildren.
                patchBlockChildren(n1.dynamicChildren, dynamicChildren, container, parentComponent, parentSuspense, isSVG, slotScopeIds);
                if (parentComponent && parentComponent.type.__hmrId) {
                    traverseStaticChildren(n1, n2);
                }
                else if (
                // #2080 if the stable fragment has a key, it's a <template v-for> that may
                //  get moved around. Make sure all root level vnodes inherit el.
                // #2134 or if it's a component root, it may also get moved around
                // as the component is being moved.
                n2.key != null ||
                    (parentComponent && n2 === parentComponent.subTree)) {
                    traverseStaticChildren(n1, n2, true /* shallow */);
                }
            }
            else {
                // keyed / unkeyed, or manual fragments.
                // for keyed & unkeyed, since they are compiler generated from v-for,
                // each child is guaranteed to be a block so the fragment will never
                // have dynamicChildren.
                patchChildren(n1, n2, container, fragmentEndAnchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
            }
        }
    };
    const processComponent = (n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized) => {
        n2.slotScopeIds = slotScopeIds;
        if (n1 == null) {
            if (n2.shapeFlag & 512 /* COMPONENT_KEPT_ALIVE */) {
                parentComponent.ctx.activate(n2, container, anchor, isSVG, optimized);
            }
            else {
                mountComponent(n2, container, anchor, parentComponent, parentSuspense, isSVG, optimized);
            }
        }
        else {
            updateComponent(n1, n2, optimized);
        }
    };
    const mountComponent = (initialVNode, container, anchor, parentComponent, parentSuspense, isSVG, optimized) => {
        const instance = (initialVNode.component = createComponentInstance(initialVNode, parentComponent, parentSuspense));
        if (instance.type.__hmrId) {
            registerHMR(instance);
        }
        {
            pushWarningContext(initialVNode);
            startMeasure(instance, `mount`);
        }
        // inject renderer internals for keepAlive
        if (isKeepAlive(initialVNode)) {
            instance.ctx.renderer = internals;
        }
        // resolve props and slots for setup context
        {
            startMeasure(instance, `init`);
        }
        setupComponent(instance);
        {
            endMeasure(instance, `init`);
        }
        // setup() is async. This component relies on async logic to be resolved
        // before proceeding
        if (instance.asyncDep) {
            parentSuspense && parentSuspense.registerDep(instance, setupRenderEffect);
            // Give it a placeholder if this is not hydration
            // TODO handle self-defined fallback
            if (!initialVNode.el) {
                const placeholder = (instance.subTree = createVNode(Comment));
                processCommentNode(null, placeholder, container, anchor);
            }
            return;
        }
        setupRenderEffect(instance, initialVNode, container, anchor, parentSuspense, isSVG, optimized);
        {
            popWarningContext();
            endMeasure(instance, `mount`);
        }
    };
    const updateComponent = (n1, n2, optimized) => {
        const instance = (n2.component = n1.component);
        if (shouldUpdateComponent(n1, n2, optimized)) {
            if (instance.asyncDep &&
                !instance.asyncResolved) {
                // async & still pending - just update props and slots
                // since the component's reactive effect for render isn't set-up yet
                {
                    pushWarningContext(n2);
                }
                updateComponentPreRender(instance, n2, optimized);
                {
                    popWarningContext();
                }
                return;
            }
            else {
                // normal update
                instance.next = n2;
                // in case the child component is also queued, remove it to avoid
                // double updating the same child component in the same flush.
                invalidateJob(instance.update);
                // instance.update is the reactive effect runner.
                instance.update();
            }
        }
        else {
            // no update needed. just copy over properties
            n2.component = n1.component;
            n2.el = n1.el;
            instance.vnode = n2;
        }
    };
    const setupRenderEffect = (instance, initialVNode, container, anchor, parentSuspense, isSVG, optimized) => {
        // create reactive effect for rendering
        instance.update = effect(function componentEffect() {
            if (!instance.isMounted) {
                let vnodeHook;
                const { el, props } = initialVNode;
                const { bm, m, parent } = instance;
                // beforeMount hook
                if (bm) {
                    invokeArrayFns(bm);
                }
                // onVnodeBeforeMount
                if ((vnodeHook = props && props.onVnodeBeforeMount)) {
                    invokeVNodeHook(vnodeHook, parent, initialVNode);
                }
                // render
                {
                    startMeasure(instance, `render`);
                }
                const subTree = (instance.subTree = renderComponentRoot(instance));
                {
                    endMeasure(instance, `render`);
                }
                if (el && hydrateNode) {
                    {
                        startMeasure(instance, `hydrate`);
                    }
                    // vnode has adopted host node - perform hydration instead of mount.
                    hydrateNode(initialVNode.el, subTree, instance, parentSuspense, null);
                    {
                        endMeasure(instance, `hydrate`);
                    }
                }
                else {
                    {
                        startMeasure(instance, `patch`);
                    }
                    patch(null, subTree, container, anchor, instance, parentSuspense, isSVG);
                    {
                        endMeasure(instance, `patch`);
                    }
                    initialVNode.el = subTree.el;
                }
                // mounted hook
                if (m) {
                    queuePostRenderEffect(m, parentSuspense);
                }
                // onVnodeMounted
                if ((vnodeHook = props && props.onVnodeMounted)) {
                    const scopedInitialVNode = initialVNode;
                    queuePostRenderEffect(() => {
                        invokeVNodeHook(vnodeHook, parent, scopedInitialVNode);
                    }, parentSuspense);
                }
                // activated hook for keep-alive roots.
                // #1742 activated hook must be accessed after first render
                // since the hook may be injected by a child keep-alive
                const { a } = instance;
                if (a &&
                    initialVNode.shapeFlag & 256 /* COMPONENT_SHOULD_KEEP_ALIVE */) {
                    queuePostRenderEffect(a, parentSuspense);
                }
                instance.isMounted = true;
                {
                    devtoolsComponentAdded(instance);
                }
                // #2458: deference mount-only object parameters to prevent memleaks
                initialVNode = container = anchor = null;
            }
            else {
                // updateComponent
                // This is triggered by mutation of component's own state (next: null)
                // OR parent calling processComponent (next: VNode)
                let { next, bu, u, parent, vnode } = instance;
                let originNext = next;
                let vnodeHook;
                {
                    pushWarningContext(next || instance.vnode);
                }
                if (next) {
                    next.el = vnode.el;
                    updateComponentPreRender(instance, next, optimized);
                }
                else {
                    next = vnode;
                }
                // beforeUpdate hook
                if (bu) {
                    invokeArrayFns(bu);
                }
                // onVnodeBeforeUpdate
                if ((vnodeHook = next.props && next.props.onVnodeBeforeUpdate)) {
                    invokeVNodeHook(vnodeHook, parent, next, vnode);
                }
                // render
                {
                    startMeasure(instance, `render`);
                }
                const nextTree = renderComponentRoot(instance);
                {
                    endMeasure(instance, `render`);
                }
                const prevTree = instance.subTree;
                instance.subTree = nextTree;
                {
                    startMeasure(instance, `patch`);
                }
                patch(prevTree, nextTree, 
                // parent may have changed if it's in a teleport
                hostParentNode(prevTree.el), 
                // anchor may have changed if it's in a fragment
                getNextHostNode(prevTree), instance, parentSuspense, isSVG);
                {
                    endMeasure(instance, `patch`);
                }
                next.el = nextTree.el;
                if (originNext === null) {
                    // self-triggered update. In case of HOC, update parent component
                    // vnode el. HOC is indicated by parent instance's subTree pointing
                    // to child component's vnode
                    updateHOCHostEl(instance, nextTree.el);
                }
                // updated hook
                if (u) {
                    queuePostRenderEffect(u, parentSuspense);
                }
                // onVnodeUpdated
                if ((vnodeHook = next.props && next.props.onVnodeUpdated)) {
                    queuePostRenderEffect(() => {
                        invokeVNodeHook(vnodeHook, parent, next, vnode);
                    }, parentSuspense);
                }
                {
                    devtoolsComponentUpdated(instance);
                }
                {
                    popWarningContext();
                }
            }
        }, createDevEffectOptions(instance) );
    };
    const updateComponentPreRender = (instance, nextVNode, optimized) => {
        nextVNode.component = instance;
        const prevProps = instance.vnode.props;
        instance.vnode = nextVNode;
        instance.next = null;
        updateProps(instance, nextVNode.props, prevProps, optimized);
        updateSlots(instance, nextVNode.children, optimized);
        pauseTracking();
        // props update may have triggered pre-flush watchers.
        // flush them before the render update.
        flushPreFlushCbs(undefined, instance.update);
        resetTracking();
    };
    const patchChildren = (n1, n2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized = false) => {
        const c1 = n1 && n1.children;
        const prevShapeFlag = n1 ? n1.shapeFlag : 0;
        const c2 = n2.children;
        const { patchFlag, shapeFlag } = n2;
        // fast path
        if (patchFlag > 0) {
            if (patchFlag & 128 /* KEYED_FRAGMENT */) {
                // this could be either fully-keyed or mixed (some keyed some not)
                // presence of patchFlag means children are guaranteed to be arrays
                patchKeyedChildren(c1, c2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
                return;
            }
            else if (patchFlag & 256 /* UNKEYED_FRAGMENT */) {
                // unkeyed
                patchUnkeyedChildren(c1, c2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
                return;
            }
        }
        // children has 3 possibilities: text, array or no children.
        if (shapeFlag & 8 /* TEXT_CHILDREN */) {
            // text children fast path
            if (prevShapeFlag & 16 /* ARRAY_CHILDREN */) {
                unmountChildren(c1, parentComponent, parentSuspense);
            }
            if (c2 !== c1) {
                hostSetElementText(container, c2);
            }
        }
        else {
            if (prevShapeFlag & 16 /* ARRAY_CHILDREN */) {
                // prev children was array
                if (shapeFlag & 16 /* ARRAY_CHILDREN */) {
                    // two arrays, cannot assume anything, do full diff
                    patchKeyedChildren(c1, c2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
                }
                else {
                    // no new children, just unmount old
                    unmountChildren(c1, parentComponent, parentSuspense, true);
                }
            }
            else {
                // prev children was text OR null
                // new children is array OR null
                if (prevShapeFlag & 8 /* TEXT_CHILDREN */) {
                    hostSetElementText(container, '');
                }
                // mount new if array
                if (shapeFlag & 16 /* ARRAY_CHILDREN */) {
                    mountChildren(c2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
                }
            }
        }
    };
    const patchUnkeyedChildren = (c1, c2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized) => {
        c1 = c1 || EMPTY_ARR;
        c2 = c2 || EMPTY_ARR;
        const oldLength = c1.length;
        const newLength = c2.length;
        const commonLength = Math.min(oldLength, newLength);
        let i;
        for (i = 0; i < commonLength; i++) {
            const nextChild = (c2[i] = optimized
                ? cloneIfMounted(c2[i])
                : normalizeVNode(c2[i]));
            patch(c1[i], nextChild, container, null, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
        }
        if (oldLength > newLength) {
            // remove old
            unmountChildren(c1, parentComponent, parentSuspense, true, false, commonLength);
        }
        else {
            // mount new
            mountChildren(c2, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized, commonLength);
        }
    };
    // can be all-keyed or mixed
    const patchKeyedChildren = (c1, c2, container, parentAnchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized) => {
        let i = 0;
        const l2 = c2.length;
        let e1 = c1.length - 1; // prev ending index
        let e2 = l2 - 1; // next ending index
        // 1. sync from start
        // (a b) c
        // (a b) d e
        while (i <= e1 && i <= e2) {
            const n1 = c1[i];
            const n2 = (c2[i] = optimized
                ? cloneIfMounted(c2[i])
                : normalizeVNode(c2[i]));
            if (isSameVNodeType(n1, n2)) {
                patch(n1, n2, container, null, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
            }
            else {
                break;
            }
            i++;
        }
        // 2. sync from end
        // a (b c)
        // d e (b c)
        while (i <= e1 && i <= e2) {
            const n1 = c1[e1];
            const n2 = (c2[e2] = optimized
                ? cloneIfMounted(c2[e2])
                : normalizeVNode(c2[e2]));
            if (isSameVNodeType(n1, n2)) {
                patch(n1, n2, container, null, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
            }
            else {
                break;
            }
            e1--;
            e2--;
        }
        // 3. common sequence + mount
        // (a b)
        // (a b) c
        // i = 2, e1 = 1, e2 = 2
        // (a b)
        // c (a b)
        // i = 0, e1 = -1, e2 = 0
        if (i > e1) {
            if (i <= e2) {
                const nextPos = e2 + 1;
                const anchor = nextPos < l2 ? c2[nextPos].el : parentAnchor;
                while (i <= e2) {
                    patch(null, (c2[i] = optimized
                        ? cloneIfMounted(c2[i])
                        : normalizeVNode(c2[i])), container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
                    i++;
                }
            }
        }
        // 4. common sequence + unmount
        // (a b) c
        // (a b)
        // i = 2, e1 = 2, e2 = 1
        // a (b c)
        // (b c)
        // i = 0, e1 = 0, e2 = -1
        else if (i > e2) {
            while (i <= e1) {
                unmount(c1[i], parentComponent, parentSuspense, true);
                i++;
            }
        }
        // 5. unknown sequence
        // [i ... e1 + 1]: a b [c d e] f g
        // [i ... e2 + 1]: a b [e d c h] f g
        // i = 2, e1 = 4, e2 = 5
        else {
            const s1 = i; // prev starting index
            const s2 = i; // next starting index
            // 5.1 build key:index map for newChildren
            const keyToNewIndexMap = new Map();
            for (i = s2; i <= e2; i++) {
                const nextChild = (c2[i] = optimized
                    ? cloneIfMounted(c2[i])
                    : normalizeVNode(c2[i]));
                if (nextChild.key != null) {
                    if (keyToNewIndexMap.has(nextChild.key)) {
                        warn(`Duplicate keys found during update:`, JSON.stringify(nextChild.key), `Make sure keys are unique.`);
                    }
                    keyToNewIndexMap.set(nextChild.key, i);
                }
            }
            // 5.2 loop through old children left to be patched and try to patch
            // matching nodes & remove nodes that are no longer present
            let j;
            let patched = 0;
            const toBePatched = e2 - s2 + 1;
            let moved = false;
            // used to track whether any node has moved
            let maxNewIndexSoFar = 0;
            // works as Map<newIndex, oldIndex>
            // Note that oldIndex is offset by +1
            // and oldIndex = 0 is a special value indicating the new node has
            // no corresponding old node.
            // used for determining longest stable subsequence
            const newIndexToOldIndexMap = new Array(toBePatched);
            for (i = 0; i < toBePatched; i++)
                newIndexToOldIndexMap[i] = 0;
            for (i = s1; i <= e1; i++) {
                const prevChild = c1[i];
                if (patched >= toBePatched) {
                    // all new children have been patched so this can only be a removal
                    unmount(prevChild, parentComponent, parentSuspense, true);
                    continue;
                }
                let newIndex;
                if (prevChild.key != null) {
                    newIndex = keyToNewIndexMap.get(prevChild.key);
                }
                else {
                    // key-less node, try to locate a key-less node of the same type
                    for (j = s2; j <= e2; j++) {
                        if (newIndexToOldIndexMap[j - s2] === 0 &&
                            isSameVNodeType(prevChild, c2[j])) {
                            newIndex = j;
                            break;
                        }
                    }
                }
                if (newIndex === undefined) {
                    unmount(prevChild, parentComponent, parentSuspense, true);
                }
                else {
                    newIndexToOldIndexMap[newIndex - s2] = i + 1;
                    if (newIndex >= maxNewIndexSoFar) {
                        maxNewIndexSoFar = newIndex;
                    }
                    else {
                        moved = true;
                    }
                    patch(prevChild, c2[newIndex], container, null, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
                    patched++;
                }
            }
            // 5.3 move and mount
            // generate longest stable subsequence only when nodes have moved
            const increasingNewIndexSequence = moved
                ? getSequence(newIndexToOldIndexMap)
                : EMPTY_ARR;
            j = increasingNewIndexSequence.length - 1;
            // looping backwards so that we can use last patched node as anchor
            for (i = toBePatched - 1; i >= 0; i--) {
                const nextIndex = s2 + i;
                const nextChild = c2[nextIndex];
                const anchor = nextIndex + 1 < l2 ? c2[nextIndex + 1].el : parentAnchor;
                if (newIndexToOldIndexMap[i] === 0) {
                    // mount new
                    patch(null, nextChild, container, anchor, parentComponent, parentSuspense, isSVG, slotScopeIds, optimized);
                }
                else if (moved) {
                    // move if:
                    // There is no stable subsequence (e.g. a reverse)
                    // OR current node is not among the stable sequence
                    if (j < 0 || i !== increasingNewIndexSequence[j]) {
                        move(nextChild, container, anchor, 2 /* REORDER */);
                    }
                    else {
                        j--;
                    }
                }
            }
        }
    };
    const move = (vnode, container, anchor, moveType, parentSuspense = null) => {
        const { el, type, transition, children, shapeFlag } = vnode;
        if (shapeFlag & 6 /* COMPONENT */) {
            move(vnode.component.subTree, container, anchor, moveType);
            return;
        }
        if (shapeFlag & 128 /* SUSPENSE */) {
            vnode.suspense.move(container, anchor, moveType);
            return;
        }
        if (shapeFlag & 64 /* TELEPORT */) {
            type.move(vnode, container, anchor, internals);
            return;
        }
        if (type === Fragment) {
            hostInsert(el, container, anchor);
            for (let i = 0; i < children.length; i++) {
                move(children[i], container, anchor, moveType);
            }
            hostInsert(vnode.anchor, container, anchor);
            return;
        }
        if (type === Static) {
            moveStaticNode(vnode, container, anchor);
            return;
        }
        // single nodes
        const needTransition = moveType !== 2 /* REORDER */ &&
            shapeFlag & 1 /* ELEMENT */ &&
            transition;
        if (needTransition) {
            if (moveType === 0 /* ENTER */) {
                transition.beforeEnter(el);
                hostInsert(el, container, anchor);
                queuePostRenderEffect(() => transition.enter(el), parentSuspense);
            }
            else {
                const { leave, delayLeave, afterLeave } = transition;
                const remove = () => hostInsert(el, container, anchor);
                const performLeave = () => {
                    leave(el, () => {
                        remove();
                        afterLeave && afterLeave();
                    });
                };
                if (delayLeave) {
                    delayLeave(el, remove, performLeave);
                }
                else {
                    performLeave();
                }
            }
        }
        else {
            hostInsert(el, container, anchor);
        }
    };
    const unmount = (vnode, parentComponent, parentSuspense, doRemove = false, optimized = false) => {
        const { type, props, ref, children, dynamicChildren, shapeFlag, patchFlag, dirs } = vnode;
        // unset ref
        if (ref != null) {
            setRef(ref, null, parentSuspense, null);
        }
        if (shapeFlag & 256 /* COMPONENT_SHOULD_KEEP_ALIVE */) {
            parentComponent.ctx.deactivate(vnode);
            return;
        }
        const shouldInvokeDirs = shapeFlag & 1 /* ELEMENT */ && dirs;
        let vnodeHook;
        if ((vnodeHook = props && props.onVnodeBeforeUnmount)) {
            invokeVNodeHook(vnodeHook, parentComponent, vnode);
        }
        if (shapeFlag & 6 /* COMPONENT */) {
            unmountComponent(vnode.component, parentSuspense, doRemove);
        }
        else {
            if (shapeFlag & 128 /* SUSPENSE */) {
                vnode.suspense.unmount(parentSuspense, doRemove);
                return;
            }
            if (shouldInvokeDirs) {
                invokeDirectiveHook(vnode, null, parentComponent, 'beforeUnmount');
            }
            if (shapeFlag & 64 /* TELEPORT */) {
                vnode.type.remove(vnode, parentComponent, parentSuspense, optimized, internals, doRemove);
            }
            else if (dynamicChildren &&
                // #1153: fast path should not be taken for non-stable (v-for) fragments
                (type !== Fragment ||
                    (patchFlag > 0 && patchFlag & 64 /* STABLE_FRAGMENT */))) {
                // fast path for block nodes: only need to unmount dynamic children.
                unmountChildren(dynamicChildren, parentComponent, parentSuspense, false, true);
            }
            else if ((type === Fragment &&
                (patchFlag & 128 /* KEYED_FRAGMENT */ ||
                    patchFlag & 256 /* UNKEYED_FRAGMENT */)) ||
                (!optimized && shapeFlag & 16 /* ARRAY_CHILDREN */)) {
                unmountChildren(children, parentComponent, parentSuspense);
            }
            if (doRemove) {
                remove(vnode);
            }
        }
        if ((vnodeHook = props && props.onVnodeUnmounted) || shouldInvokeDirs) {
            queuePostRenderEffect(() => {
                vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode);
                shouldInvokeDirs &&
                    invokeDirectiveHook(vnode, null, parentComponent, 'unmounted');
            }, parentSuspense);
        }
    };
    const remove = vnode => {
        const { type, el, anchor, transition } = vnode;
        if (type === Fragment) {
            removeFragment(el, anchor);
            return;
        }
        if (type === Static) {
            removeStaticNode(vnode);
            return;
        }
        const performRemove = () => {
            hostRemove(el);
            if (transition && !transition.persisted && transition.afterLeave) {
                transition.afterLeave();
            }
        };
        if (vnode.shapeFlag & 1 /* ELEMENT */ &&
            transition &&
            !transition.persisted) {
            const { leave, delayLeave } = transition;
            const performLeave = () => leave(el, performRemove);
            if (delayLeave) {
                delayLeave(vnode.el, performRemove, performLeave);
            }
            else {
                performLeave();
            }
        }
        else {
            performRemove();
        }
    };
    const removeFragment = (cur, end) => {
        // For fragments, directly remove all contained DOM nodes.
        // (fragment child nodes cannot have transition)
        let next;
        while (cur !== end) {
            next = hostNextSibling(cur);
            hostRemove(cur);
            cur = next;
        }
        hostRemove(end);
    };
    const unmountComponent = (instance, parentSuspense, doRemove) => {
        if (instance.type.__hmrId) {
            unregisterHMR(instance);
        }
        const { bum, effects, update, subTree, um } = instance;
        // beforeUnmount hook
        if (bum) {
            invokeArrayFns(bum);
        }
        if (effects) {
            for (let i = 0; i < effects.length; i++) {
                stop(effects[i]);
            }
        }
        // update may be null if a component is unmounted before its async
        // setup has resolved.
        if (update) {
            stop(update);
            unmount(subTree, instance, parentSuspense, doRemove);
        }
        // unmounted hook
        if (um) {
            queuePostRenderEffect(um, parentSuspense);
        }
        queuePostRenderEffect(() => {
            instance.isUnmounted = true;
        }, parentSuspense);
        // A component with async dep inside a pending suspense is unmounted before
        // its async dep resolves. This should remove the dep from the suspense, and
        // cause the suspense to resolve immediately if that was the last dep.
        if (parentSuspense &&
            parentSuspense.pendingBranch &&
            !parentSuspense.isUnmounted &&
            instance.asyncDep &&
            !instance.asyncResolved &&
            instance.suspenseId === parentSuspense.pendingId) {
            parentSuspense.deps--;
            if (parentSuspense.deps === 0) {
                parentSuspense.resolve();
            }
        }
        {
            devtoolsComponentRemoved(instance);
        }
    };
    const unmountChildren = (children, parentComponent, parentSuspense, doRemove = false, optimized = false, start = 0) => {
        for (let i = start; i < children.length; i++) {
            unmount(children[i], parentComponent, parentSuspense, doRemove, optimized);
        }
    };
    const getNextHostNode = vnode => {
        if (vnode.shapeFlag & 6 /* COMPONENT */) {
            return getNextHostNode(vnode.component.subTree);
        }
        if (vnode.shapeFlag & 128 /* SUSPENSE */) {
            return vnode.suspense.next();
        }
        return hostNextSibling((vnode.anchor || vnode.el));
    };
    const render = (vnode, container, isSVG) => {
        if (vnode == null) {
            if (container._vnode) {
                unmount(container._vnode, null, null, true);
            }
        }
        else {
            patch(container._vnode || null, vnode, container, null, null, null, isSVG);
        }
        flushPostFlushCbs();
        container._vnode = vnode;
    };
    const internals = {
        p: patch,
        um: unmount,
        m: move,
        r: remove,
        mt: mountComponent,
        mc: mountChildren,
        pc: patchChildren,
        pbc: patchBlockChildren,
        n: getNextHostNode,
        o: options
    };
    let hydrate;
    let hydrateNode;
    if (createHydrationFns) {
        [hydrate, hydrateNode] = createHydrationFns(internals);
    }
    return {
        render,
        hydrate,
        createApp: createAppAPI(render, hydrate)
    };
}
function invokeVNodeHook(hook, instance, vnode, prevVNode = null) {
    callWithAsyncErrorHandling(hook, instance, 7 /* VNODE_HOOK */, [
        vnode,
        prevVNode
    ]);
}
/**
 * #1156
 * When a component is HMR-enabled, we need to make sure that all static nodes
 * inside a block also inherit the DOM element from the previous tree so that
 * HMR updates (which are full updates) can retrieve the element for patching.
 *
 * #2080
 * Inside keyed `template` fragment static children, if a fragment is moved,
 * the children will always moved so that need inherit el form previous nodes
 * to ensure correct moved position.
 */
function traverseStaticChildren(n1, n2, shallow = false) {
    const ch1 = n1.children;
    const ch2 = n2.children;
    if (isArray(ch1) && isArray(ch2)) {
        for (let i = 0; i < ch1.length; i++) {
            // this is only called in the optimized path so array children are
            // guaranteed to be vnodes
            const c1 = ch1[i];
            let c2 = ch2[i];
            if (c2.shapeFlag & 1 /* ELEMENT */ && !c2.dynamicChildren) {
                if (c2.patchFlag <= 0 || c2.patchFlag === 32 /* HYDRATE_EVENTS */) {
                    c2 = ch2[i] = cloneIfMounted(ch2[i]);
                    c2.el = c1.el;
                }
                if (!shallow)
                    traverseStaticChildren(c1, c2);
            }
            // also inherit for comment nodes, but not placeholders (e.g. v-if which
            // would have received .el during block patch)
            if (c2.type === Comment && !c2.el) {
                c2.el = c1.el;
            }
        }
    }
}
// https://en.wikipedia.org/wiki/Longest_increasing_subsequence
function getSequence(arr) {
    const p = arr.slice();
    const result = [0];
    let i, j, u, v, c;
    const len = arr.length;
    for (i = 0; i < len; i++) {
        const arrI = arr[i];
        if (arrI !== 0) {
            j = result[result.length - 1];
            if (arr[j] < arrI) {
                p[i] = j;
                result.push(i);
                continue;
            }
            u = 0;
            v = result.length - 1;
            while (u < v) {
                c = ((u + v) / 2) | 0;
                if (arr[result[c]] < arrI) {
                    u = c + 1;
                }
                else {
                    v = c;
                }
            }
            if (arrI < arr[result[u]]) {
                if (u > 0) {
                    p[i] = result[u - 1];
                }
                result[u] = i;
            }
        }
    }
    u = result.length;
    v = result[u - 1];
    while (u-- > 0) {
        result[u] = v;
        v = p[v];
    }
    return result;
}

const isTeleport = (type) => type.__isTeleport;

const NULL_DYNAMIC_COMPONENT = Symbol();

const Fragment = Symbol('Fragment' );
const Text = Symbol('Text' );
const Comment = Symbol('Comment' );
const Static = Symbol('Static' );
// Since v-if and v-for are the two possible ways node structure can dynamically
// change, once we consider v-if branches and each v-for fragment a block, we
// can divide a template into nested blocks, and within each block the node
// structure would be stable. This allows us to skip most children diffing
// and only worry about the dynamic nodes (indicated by patch flags).
const blockStack = [];
let currentBlock = null;
/**
 * Open a block.
 * This must be called before `createBlock`. It cannot be part of `createBlock`
 * because the children of the block are evaluated before `createBlock` itself
 * is called. The generated code typically looks like this:
 *
 * ```js
 * function render() {
 *   return (openBlock(),createBlock('div', null, [...]))
 * }
 * ```
 * disableTracking is true when creating a v-for fragment block, since a v-for
 * fragment always diffs its children.
 *
 * @private
 */
function openBlock(disableTracking = false) {
    blockStack.push((currentBlock = disableTracking ? null : []));
}
function closeBlock() {
    blockStack.pop();
    currentBlock = blockStack[blockStack.length - 1] || null;
}
function isVNode(value) {
    return value ? value.__v_isVNode === true : false;
}
function isSameVNodeType(n1, n2) {
    if (n2.shapeFlag & 6 /* COMPONENT */ &&
        hmrDirtyComponents.has(n2.type)) {
        // HMR only: if the component has been hot-updated, force a reload.
        return false;
    }
    return n1.type === n2.type && n1.key === n2.key;
}
const createVNodeWithArgsTransform = (...args) => {
    return _createVNode(...(args));
};
const InternalObjectKey = `__vInternal`;
const normalizeKey = ({ key }) => key != null ? key : null;
const normalizeRef = ({ ref }) => {
    return (ref != null
        ? isString(ref) || isRef(ref) || isFunction(ref)
            ? { i: currentRenderingInstance, r: ref }
            : ref
        : null);
};
const createVNode = (createVNodeWithArgsTransform
    );
function _createVNode(type, props = null, children = null, patchFlag = 0, dynamicProps = null, isBlockNode = false) {
    if (!type || type === NULL_DYNAMIC_COMPONENT) {
        if (!type) {
            warn(`Invalid vnode type when creating vnode: ${type}.`);
        }
        type = Comment;
    }
    if (isVNode(type)) {
        // createVNode receiving an existing vnode. This happens in cases like
        // <component :is="vnode"/>
        // #2078 make sure to merge refs during the clone instead of overwriting it
        const cloned = cloneVNode(type, props, true /* mergeRef: true */);
        if (children) {
            normalizeChildren(cloned, children);
        }
        return cloned;
    }
    // class component normalization.
    if (isClassComponent(type)) {
        type = type.__vccOpts;
    }
    // class & style normalization.
    if (props) {
        // for reactive or proxy objects, we need to clone it to enable mutation.
        if (isProxy(props) || InternalObjectKey in props) {
            props = extend({}, props);
        }
        let { class: klass, style } = props;
        if (klass && !isString(klass)) {
            props.class = normalizeClass(klass);
        }
        if (isObject(style)) {
            // reactive state objects need to be cloned since they are likely to be
            // mutated
            if (isProxy(style) && !isArray(style)) {
                style = extend({}, style);
            }
            props.style = normalizeStyle(style);
        }
    }
    // encode the vnode type information into a bitmap
    const shapeFlag = isString(type)
        ? 1 /* ELEMENT */
        : isSuspense(type)
            ? 128 /* SUSPENSE */
            : isTeleport(type)
                ? 64 /* TELEPORT */
                : isObject(type)
                    ? 4 /* STATEFUL_COMPONENT */
                    : isFunction(type)
                        ? 2 /* FUNCTIONAL_COMPONENT */
                        : 0;
    if (shapeFlag & 4 /* STATEFUL_COMPONENT */ && isProxy(type)) {
        type = toRaw(type);
        warn(`Vue received a Component which was made a reactive object. This can ` +
            `lead to unnecessary performance overhead, and should be avoided by ` +
            `marking the component with \`markRaw\` or using \`shallowRef\` ` +
            `instead of \`ref\`.`, `\nComponent that was made reactive: `, type);
    }
    const vnode = {
        __v_isVNode: true,
        ["__v_skip" /* SKIP */]: true,
        type,
        props,
        key: props && normalizeKey(props),
        ref: props && normalizeRef(props),
        scopeId: currentScopeId,
        slotScopeIds: null,
        children: null,
        component: null,
        suspense: null,
        ssContent: null,
        ssFallback: null,
        dirs: null,
        transition: null,
        el: null,
        anchor: null,
        target: null,
        targetAnchor: null,
        staticCount: 0,
        shapeFlag,
        patchFlag,
        dynamicProps,
        dynamicChildren: null,
        appContext: null
    };
    // validate key
    if (vnode.key !== vnode.key) {
        warn(`VNode created with invalid key (NaN). VNode type:`, vnode.type);
    }
    normalizeChildren(vnode, children);
    // normalize suspense children
    if (shapeFlag & 128 /* SUSPENSE */) {
        const { content, fallback } = normalizeSuspenseChildren(vnode);
        vnode.ssContent = content;
        vnode.ssFallback = fallback;
    }
    if (// avoid a block node from tracking itself
        !isBlockNode &&
        // has current parent block
        currentBlock &&
        // presence of a patch flag indicates this node needs patching on updates.
        // component nodes also should always be patched, because even if the
        // component doesn't need to update, it needs to persist the instance on to
        // the next vnode so that it can be properly unmounted later.
        (patchFlag > 0 || shapeFlag & 6 /* COMPONENT */) &&
        // the EVENTS flag is only for hydration and if it is the only flag, the
        // vnode should not be considered dynamic due to handler caching.
        patchFlag !== 32 /* HYDRATE_EVENTS */) {
        currentBlock.push(vnode);
    }
    return vnode;
}
function cloneVNode(vnode, extraProps, mergeRef = false) {
    // This is intentionally NOT using spread or extend to avoid the runtime
    // key enumeration cost.
    const { props, ref, patchFlag, children } = vnode;
    const mergedProps = extraProps ? mergeProps(props || {}, extraProps) : props;
    return {
        __v_isVNode: true,
        ["__v_skip" /* SKIP */]: true,
        type: vnode.type,
        props: mergedProps,
        key: mergedProps && normalizeKey(mergedProps),
        ref: extraProps && extraProps.ref
            ? // #2078 in the case of <component :is="vnode" ref="extra"/>
                // if the vnode itself already has a ref, cloneVNode will need to merge
                // the refs so the single vnode can be set on multiple refs
                mergeRef && ref
                    ? isArray(ref)
                        ? ref.concat(normalizeRef(extraProps))
                        : [ref, normalizeRef(extraProps)]
                    : normalizeRef(extraProps)
            : ref,
        scopeId: vnode.scopeId,
        slotScopeIds: vnode.slotScopeIds,
        children: patchFlag === -1 /* HOISTED */ && isArray(children)
            ? children.map(deepCloneVNode)
            : children,
        target: vnode.target,
        targetAnchor: vnode.targetAnchor,
        staticCount: vnode.staticCount,
        shapeFlag: vnode.shapeFlag,
        // if the vnode is cloned with extra props, we can no longer assume its
        // existing patch flag to be reliable and need to add the FULL_PROPS flag.
        // note: perserve flag for fragments since they use the flag for children
        // fast paths only.
        patchFlag: extraProps && vnode.type !== Fragment
            ? patchFlag === -1 // hoisted node
                ? 16 /* FULL_PROPS */
                : patchFlag | 16 /* FULL_PROPS */
            : patchFlag,
        dynamicProps: vnode.dynamicProps,
        dynamicChildren: vnode.dynamicChildren,
        appContext: vnode.appContext,
        dirs: vnode.dirs,
        transition: vnode.transition,
        // These should technically only be non-null on mounted VNodes. However,
        // they *should* be copied for kept-alive vnodes. So we just always copy
        // them since them being non-null during a mount doesn't affect the logic as
        // they will simply be overwritten.
        component: vnode.component,
        suspense: vnode.suspense,
        ssContent: vnode.ssContent && cloneVNode(vnode.ssContent),
        ssFallback: vnode.ssFallback && cloneVNode(vnode.ssFallback),
        el: vnode.el,
        anchor: vnode.anchor
    };
}
/**
 * Dev only, for HMR of hoisted vnodes reused in v-for
 * https://github.com/vitejs/vite/issues/2022
 */
function deepCloneVNode(vnode) {
    const cloned = cloneVNode(vnode);
    if (isArray(vnode.children)) {
        cloned.children = vnode.children.map(deepCloneVNode);
    }
    return cloned;
}
/**
 * @private
 */
function createTextVNode(text = ' ', flag = 0) {
    return createVNode(Text, null, text, flag);
}
function normalizeVNode(child) {
    if (child == null || typeof child === 'boolean') {
        // empty placeholder
        return createVNode(Comment);
    }
    else if (isArray(child)) {
        // fragment
        return createVNode(Fragment, null, child);
    }
    else if (typeof child === 'object') {
        // already vnode, this should be the most common since compiled templates
        // always produce all-vnode children arrays
        return child.el === null ? child : cloneVNode(child);
    }
    else {
        // strings and numbers
        return createVNode(Text, null, String(child));
    }
}
// optimized normalization for template-compiled render fns
function cloneIfMounted(child) {
    return child.el === null ? child : cloneVNode(child);
}
function normalizeChildren(vnode, children) {
    let type = 0;
    const { shapeFlag } = vnode;
    if (children == null) {
        children = null;
    }
    else if (isArray(children)) {
        type = 16 /* ARRAY_CHILDREN */;
    }
    else if (typeof children === 'object') {
        if (shapeFlag & 1 /* ELEMENT */ || shapeFlag & 64 /* TELEPORT */) {
            // Normalize slot to plain children for plain element and Teleport
            const slot = children.default;
            if (slot) {
                // _c marker is added by withCtx() indicating this is a compiled slot
                slot._c && setCompiledSlotRendering(1);
                normalizeChildren(vnode, slot());
                slot._c && setCompiledSlotRendering(-1);
            }
            return;
        }
        else {
            type = 32 /* SLOTS_CHILDREN */;
            const slotFlag = children._;
            if (!slotFlag && !(InternalObjectKey in children)) {
                children._ctx = currentRenderingInstance;
            }
            else if (slotFlag === 3 /* FORWARDED */ && currentRenderingInstance) {
                // a child component receives forwarded slots from the parent.
                // its slot type is determined by its parent's slot type.
                if (currentRenderingInstance.vnode.patchFlag & 1024 /* DYNAMIC_SLOTS */) {
                    children._ = 2 /* DYNAMIC */;
                    vnode.patchFlag |= 1024 /* DYNAMIC_SLOTS */;
                }
                else {
                    children._ = 1 /* STABLE */;
                }
            }
        }
    }
    else if (isFunction(children)) {
        children = { default: children, _ctx: currentRenderingInstance };
        type = 32 /* SLOTS_CHILDREN */;
    }
    else {
        children = String(children);
        // force teleport children to array so it can be moved around
        if (shapeFlag & 64 /* TELEPORT */) {
            type = 16 /* ARRAY_CHILDREN */;
            children = [createTextVNode(children)];
        }
        else {
            type = 8 /* TEXT_CHILDREN */;
        }
    }
    vnode.children = children;
    vnode.shapeFlag |= type;
}
function mergeProps(...args) {
    const ret = extend({}, args[0]);
    for (let i = 1; i < args.length; i++) {
        const toMerge = args[i];
        for (const key in toMerge) {
            if (key === 'class') {
                if (ret.class !== toMerge.class) {
                    ret.class = normalizeClass([ret.class, toMerge.class]);
                }
            }
            else if (key === 'style') {
                ret.style = normalizeStyle([ret.style, toMerge.style]);
            }
            else if (isOn(key)) {
                const existing = ret[key];
                const incoming = toMerge[key];
                if (existing !== incoming) {
                    ret[key] = existing
                        ? [].concat(existing, toMerge[key])
                        : incoming;
                }
            }
            else if (key !== '') {
                ret[key] = toMerge[key];
            }
        }
    }
    return ret;
}

function provide(key, value) {
    if (!currentInstance) {
        {
            warn(`provide() can only be used inside setup().`);
        }
    }
    else {
        let provides = currentInstance.provides;
        // by default an instance inherits its parent's provides object
        // but when it needs to provide values of its own, it creates its
        // own provides object using parent provides object as prototype.
        // this way in `inject` we can simply look up injections from direct
        // parent and let the prototype chain do the work.
        const parentProvides = currentInstance.parent && currentInstance.parent.provides;
        if (parentProvides === provides) {
            provides = currentInstance.provides = Object.create(parentProvides);
        }
        // TS doesn't allow symbol as index type
        provides[key] = value;
    }
}
function inject(key, defaultValue, treatDefaultAsFactory = false) {
    // fallback to `currentRenderingInstance` so that this can be called in
    // a functional component
    const instance = currentInstance || currentRenderingInstance;
    if (instance) {
        // #2400
        // to support `app.use` plugins,
        // fallback to appContext's `provides` if the intance is at root
        const provides = instance.parent == null
            ? instance.vnode.appContext && instance.vnode.appContext.provides
            : instance.parent.provides;
        if (provides && key in provides) {
            // TS doesn't allow symbol as index type
            return provides[key];
        }
        else if (arguments.length > 1) {
            return treatDefaultAsFactory && isFunction(defaultValue)
                ? defaultValue()
                : defaultValue;
        }
        else {
            warn(`injection "${String(key)}" not found.`);
        }
    }
    else {
        warn(`inject() can only be used inside setup() or functional components.`);
    }
}

function createDuplicateChecker() {
    const cache = Object.create(null);
    return (type, key) => {
        if (cache[key]) {
            warn(`${type} property "${key}" is already defined in ${cache[key]}.`);
        }
        else {
            cache[key] = type;
        }
    };
}
let shouldCacheAccess = true;
function applyOptions(instance, options, deferredData = [], deferredWatch = [], deferredProvide = [], asMixin = false) {
    const { 
    // composition
    mixins, extends: extendsOptions, 
    // state
    data: dataOptions, computed: computedOptions, methods, watch: watchOptions, provide: provideOptions, inject: injectOptions, 
    // assets
    components, directives, 
    // lifecycle
    beforeMount, mounted, beforeUpdate, updated, activated, deactivated, beforeDestroy, beforeUnmount, destroyed, unmounted, render, renderTracked, renderTriggered, errorCaptured, 
    // public API
    expose } = options;
    const publicThis = instance.proxy;
    const ctx = instance.ctx;
    const globalMixins = instance.appContext.mixins;
    if (asMixin && render && instance.render === NOOP) {
        instance.render = render;
    }
    // applyOptions is called non-as-mixin once per instance
    if (!asMixin) {
        shouldCacheAccess = false;
        callSyncHook('beforeCreate', "bc" /* BEFORE_CREATE */, options, instance, globalMixins);
        shouldCacheAccess = true;
        // global mixins are applied first
        applyMixins(instance, globalMixins, deferredData, deferredWatch, deferredProvide);
    }
    // extending a base component...
    if (extendsOptions) {
        applyOptions(instance, extendsOptions, deferredData, deferredWatch, deferredProvide, true);
    }
    // local mixins
    if (mixins) {
        applyMixins(instance, mixins, deferredData, deferredWatch, deferredProvide);
    }
    const checkDuplicateProperties = createDuplicateChecker() ;
    {
        const [propsOptions] = instance.propsOptions;
        if (propsOptions) {
            for (const key in propsOptions) {
                checkDuplicateProperties("Props" /* PROPS */, key);
            }
        }
    }
    // options initialization order (to be consistent with Vue 2):
    // - props (already done outside of this function)
    // - inject
    // - methods
    // - data (deferred since it relies on `this` access)
    // - computed
    // - watch (deferred since it relies on `this` access)
    if (injectOptions) {
        if (isArray(injectOptions)) {
            for (let i = 0; i < injectOptions.length; i++) {
                const key = injectOptions[i];
                ctx[key] = inject(key);
                {
                    checkDuplicateProperties("Inject" /* INJECT */, key);
                }
            }
        }
        else {
            for (const key in injectOptions) {
                const opt = injectOptions[key];
                if (isObject(opt)) {
                    ctx[key] = inject(opt.from || key, opt.default, true /* treat default function as factory */);
                }
                else {
                    ctx[key] = inject(opt);
                }
                {
                    checkDuplicateProperties("Inject" /* INJECT */, key);
                }
            }
        }
    }
    if (methods) {
        for (const key in methods) {
            const methodHandler = methods[key];
            if (isFunction(methodHandler)) {
                // In dev mode, we use the `createRenderContext` function to define methods to the proxy target,
                // and those are read-only but reconfigurable, so it needs to be redefined here
                {
                    Object.defineProperty(ctx, key, {
                        value: methodHandler.bind(publicThis),
                        configurable: true,
                        enumerable: true,
                        writable: true
                    });
                }
                {
                    checkDuplicateProperties("Methods" /* METHODS */, key);
                }
            }
            else {
                warn(`Method "${key}" has type "${typeof methodHandler}" in the component definition. ` +
                    `Did you reference the function correctly?`);
            }
        }
    }
    if (!asMixin) {
        if (deferredData.length) {
            deferredData.forEach(dataFn => resolveData(instance, dataFn, publicThis));
        }
        if (dataOptions) {
            // @ts-ignore dataOptions is not fully type safe
            resolveData(instance, dataOptions, publicThis);
        }
        {
            const rawData = toRaw(instance.data);
            for (const key in rawData) {
                checkDuplicateProperties("Data" /* DATA */, key);
                // expose data on ctx during dev
                if (key[0] !== '$' && key[0] !== '_') {
                    Object.defineProperty(ctx, key, {
                        configurable: true,
                        enumerable: true,
                        get: () => rawData[key],
                        set: NOOP
                    });
                }
            }
        }
    }
    else if (dataOptions) {
        deferredData.push(dataOptions);
    }
    if (computedOptions) {
        for (const key in computedOptions) {
            const opt = computedOptions[key];
            const get = isFunction(opt)
                ? opt.bind(publicThis, publicThis)
                : isFunction(opt.get)
                    ? opt.get.bind(publicThis, publicThis)
                    : NOOP;
            if (get === NOOP) {
                warn(`Computed property "${key}" has no getter.`);
            }
            const set = !isFunction(opt) && isFunction(opt.set)
                ? opt.set.bind(publicThis)
                : () => {
                        warn(`Write operation failed: computed property "${key}" is readonly.`);
                    }
                    ;
            const c = computed$1({
                get,
                set
            });
            Object.defineProperty(ctx, key, {
                enumerable: true,
                configurable: true,
                get: () => c.value,
                set: v => (c.value = v)
            });
            {
                checkDuplicateProperties("Computed" /* COMPUTED */, key);
            }
        }
    }
    if (watchOptions) {
        deferredWatch.push(watchOptions);
    }
    if (!asMixin && deferredWatch.length) {
        deferredWatch.forEach(watchOptions => {
            for (const key in watchOptions) {
                createWatcher(watchOptions[key], ctx, publicThis, key);
            }
        });
    }
    if (provideOptions) {
        deferredProvide.push(provideOptions);
    }
    if (!asMixin && deferredProvide.length) {
        deferredProvide.forEach(provideOptions => {
            const provides = isFunction(provideOptions)
                ? provideOptions.call(publicThis)
                : provideOptions;
            Reflect.ownKeys(provides).forEach(key => {
                provide(key, provides[key]);
            });
        });
    }
    // asset options.
    // To reduce memory usage, only components with mixins or extends will have
    // resolved asset registry attached to instance.
    if (asMixin) {
        if (components) {
            extend(instance.components ||
                (instance.components = extend({}, instance.type.components)), components);
        }
        if (directives) {
            extend(instance.directives ||
                (instance.directives = extend({}, instance.type.directives)), directives);
        }
    }
    // lifecycle options
    if (!asMixin) {
        callSyncHook('created', "c" /* CREATED */, options, instance, globalMixins);
    }
    if (beforeMount) {
        onBeforeMount(beforeMount.bind(publicThis));
    }
    if (mounted) {
        onMounted(mounted.bind(publicThis));
    }
    if (beforeUpdate) {
        onBeforeUpdate(beforeUpdate.bind(publicThis));
    }
    if (updated) {
        onUpdated(updated.bind(publicThis));
    }
    if (activated) {
        onActivated(activated.bind(publicThis));
    }
    if (deactivated) {
        onDeactivated(deactivated.bind(publicThis));
    }
    if (errorCaptured) {
        onErrorCaptured(errorCaptured.bind(publicThis));
    }
    if (renderTracked) {
        onRenderTracked(renderTracked.bind(publicThis));
    }
    if (renderTriggered) {
        onRenderTriggered(renderTriggered.bind(publicThis));
    }
    if (beforeDestroy) {
        warn(`\`beforeDestroy\` has been renamed to \`beforeUnmount\`.`);
    }
    if (beforeUnmount) {
        onBeforeUnmount(beforeUnmount.bind(publicThis));
    }
    if (destroyed) {
        warn(`\`destroyed\` has been renamed to \`unmounted\`.`);
    }
    if (unmounted) {
        onUnmounted(unmounted.bind(publicThis));
    }
    if (isArray(expose)) {
        if (!asMixin) {
            if (expose.length) {
                const exposed = instance.exposed || (instance.exposed = proxyRefs({}));
                expose.forEach(key => {
                    exposed[key] = toRef(publicThis, key);
                });
            }
            else if (!instance.exposed) {
                instance.exposed = EMPTY_OBJ;
            }
        }
        else {
            warn(`The \`expose\` option is ignored when used in mixins.`);
        }
    }
}
function callSyncHook(name, type, options, instance, globalMixins) {
    for (let i = 0; i < globalMixins.length; i++) {
        callHookWithMixinAndExtends(name, type, globalMixins[i], instance);
    }
    callHookWithMixinAndExtends(name, type, options, instance);
}
function callHookWithMixinAndExtends(name, type, options, instance) {
    const { extends: base, mixins } = options;
    const selfHook = options[name];
    if (base) {
        callHookWithMixinAndExtends(name, type, base, instance);
    }
    if (mixins) {
        for (let i = 0; i < mixins.length; i++) {
            callHookWithMixinAndExtends(name, type, mixins[i], instance);
        }
    }
    if (selfHook) {
        callWithAsyncErrorHandling(selfHook.bind(instance.proxy), instance, type);
    }
}
function applyMixins(instance, mixins, deferredData, deferredWatch, deferredProvide) {
    for (let i = 0; i < mixins.length; i++) {
        applyOptions(instance, mixins[i], deferredData, deferredWatch, deferredProvide, true);
    }
}
function resolveData(instance, dataFn, publicThis) {
    if (!isFunction(dataFn)) {
        warn(`The data option must be a function. ` +
            `Plain object usage is no longer supported.`);
    }
    shouldCacheAccess = false;
    const data = dataFn.call(publicThis, publicThis);
    shouldCacheAccess = true;
    if (isPromise(data)) {
        warn(`data() returned a Promise - note data() cannot be async; If you ` +
            `intend to perform data fetching before component renders, use ` +
            `async setup() + <Suspense>.`);
    }
    if (!isObject(data)) {
        warn(`data() should return an object.`);
    }
    else if (instance.data === EMPTY_OBJ) {
        instance.data = reactive(data);
    }
    else {
        // existing data: this is a mixin or extends.
        extend(instance.data, data);
    }
}
function createWatcher(raw, ctx, publicThis, key) {
    const getter = key.includes('.')
        ? createPathGetter(publicThis, key)
        : () => publicThis[key];
    if (isString(raw)) {
        const handler = ctx[raw];
        if (isFunction(handler)) {
            watch(getter, handler);
        }
        else {
            warn(`Invalid watch handler specified by key "${raw}"`, handler);
        }
    }
    else if (isFunction(raw)) {
        watch(getter, raw.bind(publicThis));
    }
    else if (isObject(raw)) {
        if (isArray(raw)) {
            raw.forEach(r => createWatcher(r, ctx, publicThis, key));
        }
        else {
            const handler = isFunction(raw.handler)
                ? raw.handler.bind(publicThis)
                : ctx[raw.handler];
            if (isFunction(handler)) {
                watch(getter, handler, raw);
            }
            else {
                warn(`Invalid watch handler specified by key "${raw.handler}"`, handler);
            }
        }
    }
    else {
        warn(`Invalid watch option: "${key}"`, raw);
    }
}
function resolveMergedOptions(instance) {
    const raw = instance.type;
    const { __merged, mixins, extends: extendsOptions } = raw;
    if (__merged)
        return __merged;
    const globalMixins = instance.appContext.mixins;
    if (!globalMixins.length && !mixins && !extendsOptions)
        return raw;
    const options = {};
    globalMixins.forEach(m => mergeOptions(options, m, instance));
    mergeOptions(options, raw, instance);
    return (raw.__merged = options);
}
function mergeOptions(to, from, instance) {
    const strats = instance.appContext.config.optionMergeStrategies;
    const { mixins, extends: extendsOptions } = from;
    extendsOptions && mergeOptions(to, extendsOptions, instance);
    mixins &&
        mixins.forEach((m) => mergeOptions(to, m, instance));
    for (const key in from) {
        if (strats && hasOwn(strats, key)) {
            to[key] = strats[key](to[key], from[key], instance.proxy, key);
        }
        else {
            to[key] = from[key];
        }
    }
}

/**
 * #2437 In Vue 3, functional components do not have a public instance proxy but
 * they exist in the internal parent chain. For code that relies on traversing
 * public $parent chains, skip functional ones and go to the parent instead.
 */
const getPublicInstance = (i) => {
    if (!i)
        return null;
    if (isStatefulComponent(i))
        return i.exposed ? i.exposed : i.proxy;
    return getPublicInstance(i.parent);
};
const publicPropertiesMap = extend(Object.create(null), {
    $: i => i,
    $el: i => i.vnode.el,
    $data: i => i.data,
    $props: i => (shallowReadonly(i.props) ),
    $attrs: i => (shallowReadonly(i.attrs) ),
    $slots: i => (shallowReadonly(i.slots) ),
    $refs: i => (shallowReadonly(i.refs) ),
    $parent: i => getPublicInstance(i.parent),
    $root: i => getPublicInstance(i.root),
    $emit: i => i.emit,
    $options: i => (resolveMergedOptions(i) ),
    $forceUpdate: i => () => queueJob(i.update),
    $nextTick: i => nextTick.bind(i.proxy),
    $watch: i => (instanceWatch.bind(i) )
});
const PublicInstanceProxyHandlers = {
    get({ _: instance }, key) {
        const { ctx, setupState, data, props, accessCache, type, appContext } = instance;
        // let @vue/reactivity know it should never observe Vue public instances.
        if (key === "__v_skip" /* SKIP */) {
            return true;
        }
        // for internal formatters to know that this is a Vue instance
        if (key === '__isVue') {
            return true;
        }
        // data / props / ctx
        // This getter gets called for every property access on the render context
        // during render and is a major hotspot. The most expensive part of this
        // is the multiple hasOwn() calls. It's much faster to do a simple property
        // access on a plain object, so we use an accessCache object (with null
        // prototype) to memoize what access type a key corresponds to.
        let normalizedProps;
        if (key[0] !== '$') {
            const n = accessCache[key];
            if (n !== undefined) {
                switch (n) {
                    case 0 /* SETUP */:
                        return setupState[key];
                    case 1 /* DATA */:
                        return data[key];
                    case 3 /* CONTEXT */:
                        return ctx[key];
                    case 2 /* PROPS */:
                        return props[key];
                    // default: just fallthrough
                }
            }
            else if (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) {
                accessCache[key] = 0 /* SETUP */;
                return setupState[key];
            }
            else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
                accessCache[key] = 1 /* DATA */;
                return data[key];
            }
            else if (
            // only cache other properties when instance has declared (thus stable)
            // props
            (normalizedProps = instance.propsOptions[0]) &&
                hasOwn(normalizedProps, key)) {
                accessCache[key] = 2 /* PROPS */;
                return props[key];
            }
            else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
                accessCache[key] = 3 /* CONTEXT */;
                return ctx[key];
            }
            else if (shouldCacheAccess) {
                accessCache[key] = 4 /* OTHER */;
            }
        }
        const publicGetter = publicPropertiesMap[key];
        let cssModule, globalProperties;
        // public $xxx properties
        if (publicGetter) {
            if (key === '$attrs') {
                track(instance, "get" /* GET */, key);
                markAttrsAccessed();
            }
            return publicGetter(instance);
        }
        else if (
        // css module (injected by vue-loader)
        (cssModule = type.__cssModules) &&
            (cssModule = cssModule[key])) {
            return cssModule;
        }
        else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
            // user may set custom properties to `this` that start with `$`
            accessCache[key] = 3 /* CONTEXT */;
            return ctx[key];
        }
        else if (
        // global properties
        ((globalProperties = appContext.config.globalProperties),
            hasOwn(globalProperties, key))) {
            return globalProperties[key];
        }
        else if (currentRenderingInstance &&
            (!isString(key) ||
                // #1091 avoid internal isRef/isVNode checks on component instance leading
                // to infinite warning loop
                key.indexOf('__v') !== 0)) {
            if (data !== EMPTY_OBJ &&
                (key[0] === '$' || key[0] === '_') &&
                hasOwn(data, key)) {
                warn(`Property ${JSON.stringify(key)} must be accessed via $data because it starts with a reserved ` +
                    `character ("$" or "_") and is not proxied on the render context.`);
            }
            else if (instance === currentRenderingInstance) {
                warn(`Property ${JSON.stringify(key)} was accessed during render ` +
                    `but is not defined on instance.`);
            }
        }
    },
    set({ _: instance }, key, value) {
        const { data, setupState, ctx } = instance;
        if (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) {
            setupState[key] = value;
        }
        else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
            data[key] = value;
        }
        else if (hasOwn(instance.props, key)) {
            warn(`Attempting to mutate prop "${key}". Props are readonly.`, instance);
            return false;
        }
        if (key[0] === '$' && key.slice(1) in instance) {
            warn(`Attempting to mutate public property "${key}". ` +
                    `Properties starting with $ are reserved and readonly.`, instance);
            return false;
        }
        else {
            if (key in instance.appContext.config.globalProperties) {
                Object.defineProperty(ctx, key, {
                    enumerable: true,
                    configurable: true,
                    value
                });
            }
            else {
                ctx[key] = value;
            }
        }
        return true;
    },
    has({ _: { data, setupState, accessCache, ctx, appContext, propsOptions } }, key) {
        let normalizedProps;
        return (accessCache[key] !== undefined ||
            (data !== EMPTY_OBJ && hasOwn(data, key)) ||
            (setupState !== EMPTY_OBJ && hasOwn(setupState, key)) ||
            ((normalizedProps = propsOptions[0]) && hasOwn(normalizedProps, key)) ||
            hasOwn(ctx, key) ||
            hasOwn(publicPropertiesMap, key) ||
            hasOwn(appContext.config.globalProperties, key));
    }
};
{
    PublicInstanceProxyHandlers.ownKeys = (target) => {
        warn(`Avoid app logic that relies on enumerating keys on a component instance. ` +
            `The keys will be empty in production mode to avoid performance overhead.`);
        return Reflect.ownKeys(target);
    };
}
const RuntimeCompiledPublicInstanceProxyHandlers = extend({}, PublicInstanceProxyHandlers, {
    get(target, key) {
        // fast path for unscopables when using `with` block
        if (key === Symbol.unscopables) {
            return;
        }
        return PublicInstanceProxyHandlers.get(target, key, target);
    },
    has(_, key) {
        const has = key[0] !== '_' && !isGloballyWhitelisted(key);
        if (!has && PublicInstanceProxyHandlers.has(_, key)) {
            warn(`Property ${JSON.stringify(key)} should not start with _ which is a reserved prefix for Vue internals.`);
        }
        return has;
    }
});
// In dev mode, the proxy target exposes the same properties as seen on `this`
// for easier console inspection. In prod mode it will be an empty object so
// these properties definitions can be skipped.
function createRenderContext(instance) {
    const target = {};
    // expose internal instance for proxy handlers
    Object.defineProperty(target, `_`, {
        configurable: true,
        enumerable: false,
        get: () => instance
    });
    // expose public properties
    Object.keys(publicPropertiesMap).forEach(key => {
        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: false,
            get: () => publicPropertiesMap[key](instance),
            // intercepted by the proxy so no need for implementation,
            // but needed to prevent set errors
            set: NOOP
        });
    });
    // expose global properties
    const { globalProperties } = instance.appContext.config;
    Object.keys(globalProperties).forEach(key => {
        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: false,
            get: () => globalProperties[key],
            set: NOOP
        });
    });
    return target;
}
// dev only
function exposePropsOnRenderContext(instance) {
    const { ctx, propsOptions: [propsOptions] } = instance;
    if (propsOptions) {
        Object.keys(propsOptions).forEach(key => {
            Object.defineProperty(ctx, key, {
                enumerable: true,
                configurable: true,
                get: () => instance.props[key],
                set: NOOP
            });
        });
    }
}
// dev only
function exposeSetupStateOnRenderContext(instance) {
    const { ctx, setupState } = instance;
    Object.keys(toRaw(setupState)).forEach(key => {
        if (key[0] === '$' || key[0] === '_') {
            warn(`setup() return property ${JSON.stringify(key)} should not start with "$" or "_" ` +
                `which are reserved prefixes for Vue internals.`);
            return;
        }
        Object.defineProperty(ctx, key, {
            enumerable: true,
            configurable: true,
            get: () => setupState[key],
            set: NOOP
        });
    });
}

const emptyAppContext = createAppContext();
let uid$2 = 0;
function createComponentInstance(vnode, parent, suspense) {
    const type = vnode.type;
    // inherit parent app context - or - if root, adopt from root vnode
    const appContext = (parent ? parent.appContext : vnode.appContext) || emptyAppContext;
    const instance = {
        uid: uid$2++,
        vnode,
        type,
        parent,
        appContext,
        root: null,
        next: null,
        subTree: null,
        update: null,
        render: null,
        proxy: null,
        exposed: null,
        withProxy: null,
        effects: null,
        provides: parent ? parent.provides : Object.create(appContext.provides),
        accessCache: null,
        renderCache: [],
        // local resovled assets
        components: null,
        directives: null,
        // resolved props and emits options
        propsOptions: normalizePropsOptions(type, appContext),
        emitsOptions: normalizeEmitsOptions(type, appContext),
        // emit
        emit: null,
        emitted: null,
        // props default value
        propsDefaults: EMPTY_OBJ,
        // state
        ctx: EMPTY_OBJ,
        data: EMPTY_OBJ,
        props: EMPTY_OBJ,
        attrs: EMPTY_OBJ,
        slots: EMPTY_OBJ,
        refs: EMPTY_OBJ,
        setupState: EMPTY_OBJ,
        setupContext: null,
        // suspense related
        suspense,
        suspenseId: suspense ? suspense.pendingId : 0,
        asyncDep: null,
        asyncResolved: false,
        // lifecycle hooks
        // not using enums here because it results in computed properties
        isMounted: false,
        isUnmounted: false,
        isDeactivated: false,
        bc: null,
        c: null,
        bm: null,
        m: null,
        bu: null,
        u: null,
        um: null,
        bum: null,
        da: null,
        a: null,
        rtg: null,
        rtc: null,
        ec: null
    };
    {
        instance.ctx = createRenderContext(instance);
    }
    instance.root = parent ? parent.root : instance;
    instance.emit = emit.bind(null, instance);
    return instance;
}
let currentInstance = null;
const setCurrentInstance = (instance) => {
    currentInstance = instance;
};
const isBuiltInTag = /*#__PURE__*/ makeMap('slot,component');
function validateComponentName(name, config) {
    const appIsNativeTag = config.isNativeTag || NO;
    if (isBuiltInTag(name) || appIsNativeTag(name)) {
        warn('Do not use built-in or reserved HTML elements as component id: ' + name);
    }
}
function isStatefulComponent(instance) {
    return instance.vnode.shapeFlag & 4 /* STATEFUL_COMPONENT */;
}
let isInSSRComponentSetup = false;
function setupComponent(instance, isSSR = false) {
    isInSSRComponentSetup = isSSR;
    const { props, children } = instance.vnode;
    const isStateful = isStatefulComponent(instance);
    initProps(instance, props, isStateful, isSSR);
    initSlots(instance, children);
    const setupResult = isStateful
        ? setupStatefulComponent(instance, isSSR)
        : undefined;
    isInSSRComponentSetup = false;
    return setupResult;
}
function setupStatefulComponent(instance, isSSR) {
    const Component = instance.type;
    {
        if (Component.name) {
            validateComponentName(Component.name, instance.appContext.config);
        }
        if (Component.components) {
            const names = Object.keys(Component.components);
            for (let i = 0; i < names.length; i++) {
                validateComponentName(names[i], instance.appContext.config);
            }
        }
        if (Component.directives) {
            const names = Object.keys(Component.directives);
            for (let i = 0; i < names.length; i++) {
                validateDirectiveName(names[i]);
            }
        }
    }
    // 0. create render proxy property access cache
    instance.accessCache = Object.create(null);
    // 1. create public instance / render proxy
    // also mark it raw so it's never observed
    instance.proxy = new Proxy(instance.ctx, PublicInstanceProxyHandlers);
    {
        exposePropsOnRenderContext(instance);
    }
    // 2. call setup()
    const { setup } = Component;
    if (setup) {
        const setupContext = (instance.setupContext =
            setup.length > 1 ? createSetupContext(instance) : null);
        currentInstance = instance;
        pauseTracking();
        const setupResult = callWithErrorHandling(setup, instance, 0 /* SETUP_FUNCTION */, [shallowReadonly(instance.props) , setupContext]);
        resetTracking();
        currentInstance = null;
        if (isPromise(setupResult)) {
            if (isSSR) {
                // return the promise so server-renderer can wait on it
                return setupResult
                    .then((resolvedResult) => {
                    handleSetupResult(instance, resolvedResult, isSSR);
                })
                    .catch(e => {
                    handleError(e, instance, 0 /* SETUP_FUNCTION */);
                });
            }
            else {
                // async setup returned Promise.
                // bail here and wait for re-entry.
                instance.asyncDep = setupResult;
            }
        }
        else {
            handleSetupResult(instance, setupResult, isSSR);
        }
    }
    else {
        finishComponentSetup(instance, isSSR);
    }
}
function handleSetupResult(instance, setupResult, isSSR) {
    if (isFunction(setupResult)) {
        // setup returned an inline render function
        if (instance.type.__ssrInlineRender) {
            // when the function's name is `ssrRender` (compiled by SFC inline mode),
            // set it as ssrRender instead.
            instance.ssrRender = setupResult;
        }
        else {
            instance.render = setupResult;
        }
    }
    else if (isObject(setupResult)) {
        if (isVNode(setupResult)) {
            warn(`setup() should not return VNodes directly - ` +
                `return a render function instead.`);
        }
        // setup returned bindings.
        // assuming a render function compiled from template is present.
        {
            instance.devtoolsRawSetupState = setupResult;
        }
        instance.setupState = proxyRefs(setupResult);
        {
            exposeSetupStateOnRenderContext(instance);
        }
    }
    else if (setupResult !== undefined) {
        warn(`setup() should return an object. Received: ${setupResult === null ? 'null' : typeof setupResult}`);
    }
    finishComponentSetup(instance, isSSR);
}
function finishComponentSetup(instance, isSSR) {
    const Component = instance.type;
    // template / render function normalization
    if (isSSR) {
        // 1. the render function may already exist, returned by `setup`
        // 2. otherwise try to use the `Component.render`
        // 3. if the component doesn't have a render function,
        //    set `instance.render` to NOOP so that it can inherit the render
        //    function from mixins/extend
        instance.render = (instance.render ||
            Component.render ||
            NOOP);
    }
    else if (!instance.render) {
        instance.render = (Component.render || NOOP);
        // for runtime-compiled render functions using `with` blocks, the render
        // proxy used needs a different `has` handler which is more performant and
        // also only allows a whitelist of globals to fallthrough.
        if (instance.render._rc) {
            instance.withProxy = new Proxy(instance.ctx, RuntimeCompiledPublicInstanceProxyHandlers);
        }
    }
    // support for 2.x options
    {
        currentInstance = instance;
        pauseTracking();
        applyOptions(instance, Component);
        resetTracking();
        currentInstance = null;
    }
    // warn missing template/render
    // the runtime compilation of template in SSR is done by server-render
    if (!Component.render && instance.render === NOOP && !isSSR) {
        /* istanbul ignore if */
        if (Component.template) {
            warn(`Component provided template option but ` +
                `runtime compilation is not supported in this build of Vue.` +
                (``) /* should not happen */);
        }
        else {
            warn(`Component is missing template or render function.`);
        }
    }
}
const attrHandlers = {
    get: (target, key) => {
        {
            markAttrsAccessed();
        }
        return target[key];
    },
    set: () => {
        warn(`setupContext.attrs is readonly.`);
        return false;
    },
    deleteProperty: () => {
        warn(`setupContext.attrs is readonly.`);
        return false;
    }
};
function createSetupContext(instance) {
    const expose = exposed => {
        if (instance.exposed) {
            warn(`expose() should be called only once per setup().`);
        }
        instance.exposed = proxyRefs(exposed);
    };
    {
        // We use getters in dev in case libs like test-utils overwrite instance
        // properties (overwrites should not be done in prod)
        return Object.freeze({
            get attrs() {
                return new Proxy(instance.attrs, attrHandlers);
            },
            get slots() {
                return shallowReadonly(instance.slots);
            },
            get emit() {
                return (event, ...args) => instance.emit(event, ...args);
            },
            expose
        });
    }
}
// record effects created during a component's setup() so that they can be
// stopped when the component unmounts
function recordInstanceBoundEffect(effect, instance = currentInstance) {
    if (instance) {
        (instance.effects || (instance.effects = [])).push(effect);
    }
}
const classifyRE = /(?:^|[-_])(\w)/g;
const classify = (str) => str.replace(classifyRE, c => c.toUpperCase()).replace(/[-_]/g, '');
function getComponentName(Component) {
    return isFunction(Component)
        ? Component.displayName || Component.name
        : Component.name;
}
/* istanbul ignore next */
function formatComponentName(instance, Component, isRoot = false) {
    let name = getComponentName(Component);
    if (!name && Component.__file) {
        const match = Component.__file.match(/([^/\\]+)\.\w+$/);
        if (match) {
            name = match[1];
        }
    }
    if (!name && instance && instance.parent) {
        // try to infer the name based on reverse resolution
        const inferFromRegistry = (registry) => {
            for (const key in registry) {
                if (registry[key] === Component) {
                    return key;
                }
            }
        };
        name =
            inferFromRegistry(instance.components ||
                instance.parent.type.components) || inferFromRegistry(instance.appContext.components);
    }
    return name ? classify(name) : isRoot ? `App` : `Anonymous`;
}
function isClassComponent(value) {
    return isFunction(value) && '__vccOpts' in value;
}

function computed$1(getterOrOptions) {
    const c = computed(getterOrOptions);
    recordInstanceBoundEffect(c.effect);
    return c;
}

// Actual implementation
function h(type, propsOrChildren, children) {
    const l = arguments.length;
    if (l === 2) {
        if (isObject(propsOrChildren) && !isArray(propsOrChildren)) {
            // single vnode without props
            if (isVNode(propsOrChildren)) {
                return createVNode(type, null, [propsOrChildren]);
            }
            // props without children
            return createVNode(type, propsOrChildren);
        }
        else {
            // omit props
            return createVNode(type, null, propsOrChildren);
        }
    }
    else {
        if (l > 3) {
            children = Array.prototype.slice.call(arguments, 2);
        }
        else if (l === 3 && isVNode(children)) {
            children = [children];
        }
        return createVNode(type, propsOrChildren, children);
    }
}

// Core API ------------------------------------------------------------------
const version = "3.0.11";

const svgNS = 'http://www.w3.org/2000/svg';
const doc = (typeof document !== 'undefined' ? document : null);
let tempContainer;
let tempSVGContainer;
const nodeOps = {
    insert: (child, parent, anchor) => {
        parent.insertBefore(child, anchor || null);
    },
    remove: child => {
        const parent = child.parentNode;
        if (parent) {
            parent.removeChild(child);
        }
    },
    createElement: (tag, isSVG, is, props) => {
        const el = isSVG
            ? doc.createElementNS(svgNS, tag)
            : doc.createElement(tag, is ? { is } : undefined);
        if (tag === 'select' && props && props.multiple != null) {
            el.setAttribute('multiple', props.multiple);
        }
        return el;
    },
    createText: text => doc.createTextNode(text),
    createComment: text => doc.createComment(text),
    setText: (node, text) => {
        node.nodeValue = text;
    },
    setElementText: (el, text) => {
        el.textContent = text;
    },
    parentNode: node => node.parentNode,
    nextSibling: node => node.nextSibling,
    querySelector: selector => doc.querySelector(selector),
    setScopeId(el, id) {
        el.setAttribute(id, '');
    },
    cloneNode(el) {
        const cloned = el.cloneNode(true);
        // #3072
        // - in `patchDOMProp`, we store the actual value in the `el._value` property.
        // - normally, elements using `:value` bindings will not be hoisted, but if
        //   the bound value is a constant, e.g. `:value="true"` - they do get
        //   hoisted.
        // - in production, hoisted nodes are cloned when subsequent inserts, but
        //   cloneNode() does not copy the custom property we attached.
        // - This may need to account for other custom DOM properties we attach to
        //   elements in addition to `_value` in the future.
        if (`_value` in el) {
            cloned._value = el._value;
        }
        return cloned;
    },
    // __UNSAFE__
    // Reason: innerHTML.
    // Static content here can only come from compiled templates.
    // As long as the user only uses trusted templates, this is safe.
    insertStaticContent(content, parent, anchor, isSVG) {
        const temp = isSVG
            ? tempSVGContainer ||
                (tempSVGContainer = doc.createElementNS(svgNS, 'svg'))
            : tempContainer || (tempContainer = doc.createElement('div'));
        temp.innerHTML = content;
        const first = temp.firstChild;
        let node = first;
        let last = node;
        while (node) {
            last = node;
            nodeOps.insert(node, parent, anchor);
            node = temp.firstChild;
        }
        return [first, last];
    }
};

// compiler should normalize class + :class bindings on the same element
// into a single binding ['staticClass', dynamic]
function patchClass(el, value, isSVG) {
    if (value == null) {
        value = '';
    }
    if (isSVG) {
        el.setAttribute('class', value);
    }
    else {
        // directly setting className should be faster than setAttribute in theory
        // if this is an element during a transition, take the temporary transition
        // classes into account.
        const transitionClasses = el._vtc;
        if (transitionClasses) {
            value = (value
                ? [value, ...transitionClasses]
                : [...transitionClasses]).join(' ');
        }
        el.className = value;
    }
}

function patchStyle(el, prev, next) {
    const style = el.style;
    if (!next) {
        el.removeAttribute('style');
    }
    else if (isString(next)) {
        if (prev !== next) {
            const current = style.display;
            style.cssText = next;
            // indicates that the `display` of the element is controlled by `v-show`,
            // so we always keep the current `display` value regardless of the `style` value,
            // thus handing over control to `v-show`.
            if ('_vod' in el) {
                style.display = current;
            }
        }
    }
    else {
        for (const key in next) {
            setStyle(style, key, next[key]);
        }
        if (prev && !isString(prev)) {
            for (const key in prev) {
                if (next[key] == null) {
                    setStyle(style, key, '');
                }
            }
        }
    }
}
const importantRE = /\s*!important$/;
function setStyle(style, name, val) {
    if (isArray(val)) {
        val.forEach(v => setStyle(style, name, v));
    }
    else {
        if (name.startsWith('--')) {
            // custom property definition
            style.setProperty(name, val);
        }
        else {
            const prefixed = autoPrefix(style, name);
            if (importantRE.test(val)) {
                // !important
                style.setProperty(hyphenate(prefixed), val.replace(importantRE, ''), 'important');
            }
            else {
                style[prefixed] = val;
            }
        }
    }
}
const prefixes = ['Webkit', 'Moz', 'ms'];
const prefixCache = {};
function autoPrefix(style, rawName) {
    const cached = prefixCache[rawName];
    if (cached) {
        return cached;
    }
    let name = camelize(rawName);
    if (name !== 'filter' && name in style) {
        return (prefixCache[rawName] = name);
    }
    name = capitalize(name);
    for (let i = 0; i < prefixes.length; i++) {
        const prefixed = prefixes[i] + name;
        if (prefixed in style) {
            return (prefixCache[rawName] = prefixed);
        }
    }
    return rawName;
}

const xlinkNS = 'http://www.w3.org/1999/xlink';
function patchAttr(el, key, value, isSVG) {
    if (isSVG && key.startsWith('xlink:')) {
        if (value == null) {
            el.removeAttributeNS(xlinkNS, key.slice(6, key.length));
        }
        else {
            el.setAttributeNS(xlinkNS, key, value);
        }
    }
    else {
        // note we are only checking boolean attributes that don't have a
        // corresponding dom prop of the same name here.
        const isBoolean = isSpecialBooleanAttr(key);
        if (value == null || (isBoolean && value === false)) {
            el.removeAttribute(key);
        }
        else {
            el.setAttribute(key, isBoolean ? '' : value);
        }
    }
}

// __UNSAFE__
// functions. The user is responsible for using them with only trusted content.
function patchDOMProp(el, key, value, 
// the following args are passed only due to potential innerHTML/textContent
// overriding existing VNodes, in which case the old tree must be properly
// unmounted.
prevChildren, parentComponent, parentSuspense, unmountChildren) {
    if (key === 'innerHTML' || key === 'textContent') {
        if (prevChildren) {
            unmountChildren(prevChildren, parentComponent, parentSuspense);
        }
        el[key] = value == null ? '' : value;
        return;
    }
    if (key === 'value' && el.tagName !== 'PROGRESS') {
        // store value as _value as well since
        // non-string values will be stringified.
        el._value = value;
        const newValue = value == null ? '' : value;
        if (el.value !== newValue) {
            el.value = newValue;
        }
        return;
    }
    if (value === '' || value == null) {
        const type = typeof el[key];
        if (value === '' && type === 'boolean') {
            // e.g. <select multiple> compiles to { multiple: '' }
            el[key] = true;
            return;
        }
        else if (value == null && type === 'string') {
            // e.g. <div :id="null">
            el[key] = '';
            el.removeAttribute(key);
            return;
        }
        else if (type === 'number') {
            // e.g. <img :width="null">
            el[key] = 0;
            el.removeAttribute(key);
            return;
        }
    }
    // some properties perform value validation and throw
    try {
        el[key] = value;
    }
    catch (e) {
        {
            warn(`Failed setting prop "${key}" on <${el.tagName.toLowerCase()}>: ` +
                `value ${value} is invalid.`, e);
        }
    }
}

// Async edge case fix requires storing an event listener's attach timestamp.
let _getNow = Date.now;
let skipTimestampCheck = false;
if (typeof window !== 'undefined') {
    // Determine what event timestamp the browser is using. Annoyingly, the
    // timestamp can either be hi-res (relative to page load) or low-res
    // (relative to UNIX epoch), so in order to compare time we have to use the
    // same timestamp type when saving the flush timestamp.
    if (_getNow() > document.createEvent('Event').timeStamp) {
        // if the low-res timestamp which is bigger than the event timestamp
        // (which is evaluated AFTER) it means the event is using a hi-res timestamp,
        // and we need to use the hi-res version for event listeners as well.
        _getNow = () => performance.now();
    }
    // #3485: Firefox <= 53 has incorrect Event.timeStamp implementation
    // and does not fire microtasks in between event propagation, so safe to exclude.
    const ffMatch = navigator.userAgent.match(/firefox\/(\d+)/i);
    skipTimestampCheck = !!(ffMatch && Number(ffMatch[1]) <= 53);
}
// To avoid the overhead of repeatedly calling performance.now(), we cache
// and use the same timestamp for all event listeners attached in the same tick.
let cachedNow = 0;
const p = Promise.resolve();
const reset = () => {
    cachedNow = 0;
};
const getNow = () => cachedNow || (p.then(reset), (cachedNow = _getNow()));
function addEventListener(el, event, handler, options) {
    el.addEventListener(event, handler, options);
}
function removeEventListener(el, event, handler, options) {
    el.removeEventListener(event, handler, options);
}
function patchEvent(el, rawName, prevValue, nextValue, instance = null) {
    // vei = vue event invokers
    const invokers = el._vei || (el._vei = {});
    const existingInvoker = invokers[rawName];
    if (nextValue && existingInvoker) {
        // patch
        existingInvoker.value = nextValue;
    }
    else {
        const [name, options] = parseName(rawName);
        if (nextValue) {
            // add
            const invoker = (invokers[rawName] = createInvoker(nextValue, instance));
            addEventListener(el, name, invoker, options);
        }
        else if (existingInvoker) {
            // remove
            removeEventListener(el, name, existingInvoker, options);
            invokers[rawName] = undefined;
        }
    }
}
const optionsModifierRE = /(?:Once|Passive|Capture)$/;
function parseName(name) {
    let options;
    if (optionsModifierRE.test(name)) {
        options = {};
        let m;
        while ((m = name.match(optionsModifierRE))) {
            name = name.slice(0, name.length - m[0].length);
            options[m[0].toLowerCase()] = true;
        }
    }
    return [hyphenate(name.slice(2)), options];
}
function createInvoker(initialValue, instance) {
    const invoker = (e) => {
        // async edge case #6566: inner click event triggers patch, event handler
        // attached to outer element during patch, and triggered again. This
        // happens because browsers fire microtask ticks between event propagation.
        // the solution is simple: we save the timestamp when a handler is attached,
        // and the handler would only fire if the event passed to it was fired
        // AFTER it was attached.
        const timeStamp = e.timeStamp || _getNow();
        if (skipTimestampCheck || timeStamp >= invoker.attached - 1) {
            callWithAsyncErrorHandling(patchStopImmediatePropagation(e, invoker.value), instance, 5 /* NATIVE_EVENT_HANDLER */, [e]);
        }
    };
    invoker.value = initialValue;
    invoker.attached = getNow();
    return invoker;
}
function patchStopImmediatePropagation(e, value) {
    if (isArray(value)) {
        const originalStop = e.stopImmediatePropagation;
        e.stopImmediatePropagation = () => {
            originalStop.call(e);
            e._stopped = true;
        };
        return value.map(fn => (e) => !e._stopped && fn(e));
    }
    else {
        return value;
    }
}

const nativeOnRE = /^on[a-z]/;
const forcePatchProp = (_, key) => key === 'value';
const patchProp = (el, key, prevValue, nextValue, isSVG = false, prevChildren, parentComponent, parentSuspense, unmountChildren) => {
    switch (key) {
        // special
        case 'class':
            patchClass(el, nextValue, isSVG);
            break;
        case 'style':
            patchStyle(el, prevValue, nextValue);
            break;
        default:
            if (isOn(key)) {
                // ignore v-model listeners
                if (!isModelListener(key)) {
                    patchEvent(el, key, prevValue, nextValue, parentComponent);
                }
            }
            else if (shouldSetAsProp(el, key, nextValue, isSVG)) {
                patchDOMProp(el, key, nextValue, prevChildren, parentComponent, parentSuspense, unmountChildren);
            }
            else {
                // special case for <input v-model type="checkbox"> with
                // :true-value & :false-value
                // store value as dom properties since non-string values will be
                // stringified.
                if (key === 'true-value') {
                    el._trueValue = nextValue;
                }
                else if (key === 'false-value') {
                    el._falseValue = nextValue;
                }
                patchAttr(el, key, nextValue, isSVG);
            }
            break;
    }
};
function shouldSetAsProp(el, key, value, isSVG) {
    if (isSVG) {
        // most keys must be set as attribute on svg elements to work
        // ...except innerHTML
        if (key === 'innerHTML') {
            return true;
        }
        // or native onclick with function values
        if (key in el && nativeOnRE.test(key) && isFunction(value)) {
            return true;
        }
        return false;
    }
    // spellcheck and draggable are numerated attrs, however their
    // corresponding DOM properties are actually booleans - this leads to
    // setting it with a string "false" value leading it to be coerced to
    // `true`, so we need to always treat them as attributes.
    // Note that `contentEditable` doesn't have this problem: its DOM
    // property is also enumerated string values.
    if (key === 'spellcheck' || key === 'draggable') {
        return false;
    }
    // #1787, #2840 form property on form elements is readonly and must be set as
    // attribute.
    if (key === 'form') {
        return false;
    }
    // #1526 <input list> must be set as attribute
    if (key === 'list' && el.tagName === 'INPUT') {
        return false;
    }
    // #2766 <textarea type> must be set as attribute
    if (key === 'type' && el.tagName === 'TEXTAREA') {
        return false;
    }
    // native onclick with string value, must be set as attribute
    if (nativeOnRE.test(key) && isString(value)) {
        return false;
    }
    return key in el;
}

const rendererOptions = extend({ patchProp, forcePatchProp }, nodeOps);
// lazy create the renderer - this makes core renderer logic tree-shakable
// in case the user only imports reactivity utilities from Vue.
let renderer;
function ensureRenderer() {
    return renderer || (renderer = createRenderer(rendererOptions));
}
const createApp = ((...args) => {
    const app = ensureRenderer().createApp(...args);
    {
        injectNativeTagCheck(app);
        injectCustomElementCheck(app);
    }
    const { mount } = app;
    app.mount = (containerOrSelector) => {
        const container = normalizeContainer(containerOrSelector);
        if (!container)
            return;
        const component = app._component;
        if (!isFunction(component) && !component.render && !component.template) {
            component.template = container.innerHTML;
        }
        // clear content before mounting
        container.innerHTML = '';
        const proxy = mount(container, false, container instanceof SVGElement);
        if (container instanceof Element) {
            container.removeAttribute('v-cloak');
            container.setAttribute('data-v-app', '');
        }
        return proxy;
    };
    return app;
});
function injectNativeTagCheck(app) {
    // Inject `isNativeTag`
    // this is used for component name validation (dev only)
    Object.defineProperty(app.config, 'isNativeTag', {
        value: (tag) => isHTMLTag(tag) || isSVGTag(tag),
        writable: false
    });
}
// dev only
function injectCustomElementCheck(app) {
    {
        const value = app.config.isCustomElement;
        Object.defineProperty(app.config, 'isCustomElement', {
            get() {
                return value;
            },
            set() {
                warn(`The \`isCustomElement\` config option is only respected when using the runtime compiler.` +
                    `If you are using the runtime-only build, \`isCustomElement\` must be passed to \`@vue/compiler-dom\` in the build setup instead` +
                    `- for example, via the \`compilerOptions\` option in vue-loader: https://vue-loader.vuejs.org/options.html#compileroptions.`);
            }
        });
    }
}
function normalizeContainer(container) {
    if (isString(container)) {
        const res = document.querySelector(container);
        if (!res) {
            warn(`Failed to mount app: mount target selector "${container}" returned null.`);
        }
        return res;
    }
    if (container instanceof window.ShadowRoot &&
        container.mode === 'closed') {
        warn(`mounting on a ShadowRoot with \`{mode: "closed"}\` may lead to unpredictable bugs`);
    }
    return container;
}

const ssrMode = ref(false);
const compilerOptions = reactive({
    mode: 'module',
    filename: 'Foo.vue',
    prefixIdentifiers: false,
    optimizeImports: false,
    hoistStatic: false,
    cacheHandlers: false,
    scopeId: null,
    inline: false,
    ssrCssVars: `{ color }`,
    bindingMetadata: {
        TestComponent: "setup-const" /* SETUP_CONST */,
        setupRef: "setup-ref" /* SETUP_REF */,
        setupConst: "setup-const" /* SETUP_CONST */,
        setupLet: "setup-let" /* SETUP_LET */,
        setupMaybeRef: "setup-maybe-ref" /* SETUP_MAYBE_REF */,
        setupProp: "props" /* PROPS */,
        vMySetupDir: "setup-const" /* SETUP_CONST */
    }
});
const App = {
    setup() {
        return () => {
            const isSSR = ssrMode.value;
            const isModule = compilerOptions.mode === 'module';
            const usePrefix = compilerOptions.prefixIdentifiers || compilerOptions.mode === 'module';
            return [
                h('h1', `Vue 3 Template Explorer`),
                h('a', {
                    href: `https://github.com/vuejs/vue-next/tree/${"c9cac74"}`,
                    target: `_blank`
                }, `@${"c9cac74"}`),
                ' | ',
                h('a', {
                    href: 'https://app.netlify.com/sites/vue-next-template-explorer/deploys',
                    target: `_blank`
                }, 'History'),
                h('div', { id: 'options-wrapper' }, [
                    h('div', { id: 'options-label' }, 'Options ↘'),
                    h('ul', { id: 'options' }, [
                        // mode selection
                        h('li', { id: 'mode' }, [
                            h('span', { class: 'label' }, 'Mode: '),
                            h('input', {
                                type: 'radio',
                                id: 'mode-module',
                                name: 'mode',
                                checked: isModule,
                                onChange() {
                                    compilerOptions.mode = 'module';
                                }
                            }),
                            h('label', { for: 'mode-module' }, 'module'),
                            ' ',
                            h('input', {
                                type: 'radio',
                                id: 'mode-function',
                                name: 'mode',
                                checked: !isModule,
                                onChange() {
                                    compilerOptions.mode = 'function';
                                }
                            }),
                            h('label', { for: 'mode-function' }, 'function')
                        ]),
                        // SSR
                        h('li', [
                            h('input', {
                                type: 'checkbox',
                                id: 'ssr',
                                name: 'ssr',
                                checked: ssrMode.value,
                                onChange(e) {
                                    ssrMode.value = e.target.checked;
                                }
                            }),
                            h('label', { for: 'ssr' }, 'SSR')
                        ]),
                        // toggle prefixIdentifiers
                        h('li', [
                            h('input', {
                                type: 'checkbox',
                                id: 'prefix',
                                disabled: isModule || isSSR,
                                checked: usePrefix || isSSR,
                                onChange(e) {
                                    compilerOptions.prefixIdentifiers =
                                        e.target.checked || isModule;
                                }
                            }),
                            h('label', { for: 'prefix' }, 'prefixIdentifiers')
                        ]),
                        // toggle hoistStatic
                        h('li', [
                            h('input', {
                                type: 'checkbox',
                                id: 'hoist',
                                checked: compilerOptions.hoistStatic && !isSSR,
                                disabled: isSSR,
                                onChange(e) {
                                    compilerOptions.hoistStatic = e.target.checked;
                                }
                            }),
                            h('label', { for: 'hoist' }, 'hoistStatic')
                        ]),
                        // toggle cacheHandlers
                        h('li', [
                            h('input', {
                                type: 'checkbox',
                                id: 'cache',
                                checked: usePrefix && compilerOptions.cacheHandlers && !isSSR,
                                disabled: !usePrefix || isSSR,
                                onChange(e) {
                                    compilerOptions.cacheHandlers = e.target.checked;
                                }
                            }),
                            h('label', { for: 'cache' }, 'cacheHandlers')
                        ]),
                        // toggle scopeId
                        h('li', [
                            h('input', {
                                type: 'checkbox',
                                id: 'scope-id',
                                disabled: !isModule,
                                checked: isModule && compilerOptions.scopeId,
                                onChange(e) {
                                    compilerOptions.scopeId =
                                        isModule && e.target.checked
                                            ? 'scope-id'
                                            : null;
                                }
                            }),
                            h('label', { for: 'scope-id' }, 'scopeId')
                        ]),
                        // inline mode
                        h('li', [
                            h('input', {
                                type: 'checkbox',
                                id: 'inline',
                                checked: compilerOptions.inline,
                                onChange(e) {
                                    compilerOptions.inline = e.target.checked;
                                }
                            }),
                            h('label', { for: 'inline' }, 'inline')
                        ]),
                        // toggle optimizeImports
                        h('li', [
                            h('input', {
                                type: 'checkbox',
                                id: 'optimize-imports',
                                disabled: !isModule || isSSR,
                                checked: isModule && !isSSR && compilerOptions.optimizeImports,
                                onChange(e) {
                                    compilerOptions.optimizeImports = e.target.checked;
                                }
                            }),
                            h('label', { for: 'optimize-imports' }, 'optimizeImports')
                        ])
                    ])
                ])
            ];
        };
    }
};
function initOptions() {
    createApp(App).mount(document.getElementById('header'));
}

var theme = {
    base: 'vs-dark',
    inherit: true,
    rules: [
        {
            foreground: 'de935f',
            token: 'number'
        },
        {
            foreground: '969896',
            token: 'comment'
        },
        {
            foreground: 'ced1cf',
            token: 'keyword.operator.class'
        },
        {
            foreground: 'ced1cf',
            token: 'constant.other'
        },
        {
            foreground: 'ced1cf',
            token: 'source.php.embedded.line'
        },
        {
            foreground: 'cc6666',
            token: 'variable'
        },
        {
            foreground: 'cc6666',
            token: 'support.other.variable'
        },
        {
            foreground: 'cc6666',
            token: 'string.other.link'
        },
        {
            foreground: 'cc6666',
            token: 'string.regexp'
        },
        {
            foreground: 'cc6666',
            token: 'entity.name.tag'
        },
        {
            foreground: 'cc6666',
            token: 'entity.other.attribute-name'
        },
        {
            foreground: 'cc6666',
            token: 'meta.tag'
        },
        {
            foreground: 'cc6666',
            token: 'declaration.tag'
        },
        {
            foreground: 'cc6666',
            token: 'markup.deleted.git_gutter'
        },
        {
            foreground: 'de935f',
            token: 'constant.numeric'
        },
        {
            foreground: 'de935f',
            token: 'constant.language'
        },
        {
            foreground: 'de935f',
            token: 'support.constant'
        },
        {
            foreground: 'de935f',
            token: 'constant.character'
        },
        {
            foreground: 'de935f',
            token: 'variable.parameter'
        },
        {
            foreground: 'de935f',
            token: 'punctuation.section.embedded'
        },
        {
            foreground: 'de935f',
            token: 'keyword.other.unit'
        },
        {
            foreground: 'f0c674',
            token: 'entity.name.class'
        },
        {
            foreground: 'f0c674',
            token: 'entity.name.type.class'
        },
        {
            foreground: 'f0c674',
            token: 'support.type'
        },
        {
            foreground: 'f0c674',
            token: 'support.class'
        },
        {
            foreground: 'b5bd68',
            token: 'string'
        },
        {
            foreground: 'b5bd68',
            token: 'constant.other.symbol'
        },
        {
            foreground: 'b5bd68',
            token: 'entity.other.inherited-class'
        },
        {
            foreground: 'b5bd68',
            token: 'markup.heading'
        },
        {
            foreground: 'b5bd68',
            token: 'markup.inserted.git_gutter'
        },
        {
            foreground: '8abeb7',
            token: 'keyword.operator'
        },
        {
            foreground: '8abeb7',
            token: 'constant.other.color'
        },
        {
            foreground: '81a2be',
            token: 'entity.name.function'
        },
        {
            foreground: '81a2be',
            token: 'meta.function-call'
        },
        {
            foreground: '81a2be',
            token: 'support.function'
        },
        {
            foreground: '81a2be',
            token: 'keyword.other.special-method'
        },
        {
            foreground: '81a2be',
            token: 'meta.block-level'
        },
        {
            foreground: '81a2be',
            token: 'markup.changed.git_gutter'
        },
        {
            foreground: 'b294bb',
            token: 'keyword'
        },
        {
            foreground: 'b294bb',
            token: 'storage'
        },
        {
            foreground: 'b294bb',
            token: 'storage.type'
        },
        {
            foreground: 'b294bb',
            token: 'entity.name.tag.css'
        },
        {
            foreground: 'ced2cf',
            background: 'df5f5f',
            token: 'invalid'
        },
        {
            foreground: 'ced2cf',
            background: '82a3bf',
            token: 'meta.separator'
        },
        {
            foreground: 'ced2cf',
            background: 'b798bf',
            token: 'invalid.deprecated'
        },
        {
            foreground: 'ffffff',
            token: 'markup.inserted.diff'
        },
        {
            foreground: 'ffffff',
            token: 'markup.deleted.diff'
        },
        {
            foreground: 'ffffff',
            token: 'meta.diff.header.to-file'
        },
        {
            foreground: 'ffffff',
            token: 'meta.diff.header.from-file'
        },
        {
            foreground: '718c00',
            token: 'markup.inserted.diff'
        },
        {
            foreground: '718c00',
            token: 'meta.diff.header.to-file'
        },
        {
            foreground: 'c82829',
            token: 'markup.deleted.diff'
        },
        {
            foreground: 'c82829',
            token: 'meta.diff.header.from-file'
        },
        {
            foreground: 'ffffff',
            background: '4271ae',
            token: 'meta.diff.header.from-file'
        },
        {
            foreground: 'ffffff',
            background: '4271ae',
            token: 'meta.diff.header.to-file'
        },
        {
            foreground: '3e999f',
            fontStyle: 'italic',
            token: 'meta.diff.range'
        }
    ],
    colors: {
        'editor.foreground': '#C5C8C6',
        'editor.background': '#1D1F21',
        'editor.selectionBackground': '#373B41',
        'editor.lineHighlightBackground': '#282A2E',
        'editorCursor.foreground': '#AEAFAD',
        'editorWhitespace.foreground': '#4B4E55'
    }
};

const sharedEditorOptions = {
    fontSize: 14,
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    minimap: {
        enabled: false
    }
};
window.init = () => {
    const monaco = window.monaco;
    monaco.editor.defineTheme('my-theme', theme);
    monaco.editor.setTheme('my-theme');
    const persistedState = JSON.parse(decodeURIComponent(window.location.hash.slice(1)) ||
        localStorage.getItem('state') ||
        `{}`);
    ssrMode.value = persistedState.ssr;
    Object.assign(compilerOptions, persistedState.options);
    let lastSuccessfulCode;
    let lastSuccessfulMap = undefined;
    function compileCode(source) {
        console.clear();
        try {
            const errors = [];
            const compileFn = ssrMode.value ? compile$1 : compile;
            const start = performance.now();
            const { code, ast, map } = compileFn(source, {
                filename: 'ExampleTemplate.vue',
                ...compilerOptions,
                sourceMap: true,
                onError: err => {
                    errors.push(err);
                }
            });
            console.log(`Compiled in ${(performance.now() - start).toFixed(2)}ms.`);
            monaco.editor.setModelMarkers(editor.getModel(), `@vue/compiler-dom`, errors.filter(e => e.loc).map(formatError));
            console.log(`AST: `, ast);
            console.log(`Options: `, toRaw(compilerOptions));
            lastSuccessfulCode = code + `\n\n// Check the console for the AST`;
            lastSuccessfulMap = new sourceMap.SourceMapConsumer(map);
            lastSuccessfulMap.computeColumnSpans();
        }
        catch (e) {
            lastSuccessfulCode = `/* ERROR: ${e.message} (see console for more info) */`;
            console.error(e);
        }
        return lastSuccessfulCode;
    }
    function formatError(err) {
        const loc = err.loc;
        return {
            severity: monaco.MarkerSeverity.Error,
            startLineNumber: loc.start.line,
            startColumn: loc.start.column,
            endLineNumber: loc.end.line,
            endColumn: loc.end.column,
            message: `Vue template compilation error: ${err.message}`,
            code: String(err.code)
        };
    }
    function reCompile() {
        const src = editor.getValue();
        // every time we re-compile, persist current state
        const state = JSON.stringify({
            src,
            ssr: ssrMode.value,
            options: compilerOptions
        });
        localStorage.setItem('state', state);
        window.location.hash = encodeURIComponent(state);
        const res = compileCode(src);
        if (res) {
            output.setValue(res);
        }
    }
    const editor = monaco.editor.create(document.getElementById('source'), {
        value: persistedState.src || `<div>Hello World!</div>`,
        language: 'html',
        ...sharedEditorOptions,
        wordWrap: 'bounded'
    });
    editor.getModel().updateOptions({
        tabSize: 2
    });
    const output = monaco.editor.create(document.getElementById('output'), {
        value: '',
        language: 'javascript',
        readOnly: true,
        ...sharedEditorOptions
    });
    output.getModel().updateOptions({
        tabSize: 2
    });
    // handle resize
    window.addEventListener('resize', () => {
        editor.layout();
        output.layout();
    });
    // update compile output when input changes
    editor.onDidChangeModelContent(debounce(reCompile));
    // highlight output code
    let prevOutputDecos = [];
    function clearOutputDecos() {
        prevOutputDecos = output.deltaDecorations(prevOutputDecos, []);
    }
    editor.onDidChangeCursorPosition(debounce(e => {
        clearEditorDecos();
        if (lastSuccessfulMap) {
            const pos = lastSuccessfulMap.generatedPositionFor({
                source: 'ExampleTemplate.vue',
                line: e.position.lineNumber,
                column: e.position.column - 1
            });
            if (pos.line != null && pos.column != null) {
                prevOutputDecos = output.deltaDecorations(prevOutputDecos, [
                    {
                        range: new monaco.Range(pos.line, pos.column + 1, pos.line, pos.lastColumn ? pos.lastColumn + 2 : pos.column + 2),
                        options: {
                            inlineClassName: `highlight`
                        }
                    }
                ]);
                output.revealPositionInCenter({
                    lineNumber: pos.line,
                    column: pos.column + 1
                });
            }
            else {
                clearOutputDecos();
            }
        }
    }, 100));
    let previousEditorDecos = [];
    function clearEditorDecos() {
        previousEditorDecos = editor.deltaDecorations(previousEditorDecos, []);
    }
    output.onDidChangeCursorPosition(debounce(e => {
        clearOutputDecos();
        if (lastSuccessfulMap) {
            const pos = lastSuccessfulMap.originalPositionFor({
                line: e.position.lineNumber,
                column: e.position.column - 1
            });
            if (pos.line != null &&
                pos.column != null &&
                !(pos.line === 1 && pos.column === 0)) {
                const translatedPos = {
                    column: pos.column + 1,
                    lineNumber: pos.line
                };
                previousEditorDecos = editor.deltaDecorations(previousEditorDecos, [
                    {
                        range: new monaco.Range(pos.line, pos.column + 1, pos.line, pos.column + 1),
                        options: {
                            isWholeLine: true,
                            className: `highlight`
                        }
                    }
                ]);
                editor.revealPositionInCenter(translatedPos);
            }
            else {
                clearEditorDecos();
            }
        }
    }, 100));
    initOptions();
    watchEffect(reCompile);
};
function debounce(fn, delay = 300) {
    let prevTimer = null;
    return ((...args) => {
        if (prevTimer) {
            clearTimeout(prevTimer);
        }
        prevTimer = window.setTimeout(() => {
            fn(...args);
            prevTimer = null;
        }, delay);
    });
}
