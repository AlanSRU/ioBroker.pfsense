// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        // specify files to exclude from linting here
        ignores: [
            '.dev-server/',
            '.vscode/',
            '*.test.js',
            'test/**/*.js',
            '*.config.mjs',
            'build',
            'dist',
            'admin/words.js',
            'admin/admin.d.ts',
            'admin/blockly.js',
            '**/adapter-config.d.ts',
            'widgets/**/*.js'
        ],
    },
    {
        // you may disable some 'jsdoc' warnings - but using jsdoc is highly recommended
        // as this improves maintainability. jsdoc warnings will not block build process.
        rules: {
            // 'jsdoc/require-jsdoc': 'off',
            // TypeScript signatures already document parameter types
            'jsdoc/require-param': 'off',
            // 'jsdoc/require-param-description': 'off',
            // 'jsdoc/require-returns-description': 'off',
            // 'jsdoc/require-returns-check': 'off',
        },
    },
    {
        // Same as @iobroker/eslint-config, minus TSPropertySignature: interface fields are named for
        // what they hold and documenting each one would only repeat the name.
        rules: {
            'jsdoc/require-jsdoc': [
                'warn',
                {
                    publicOnly: true,
                    require: { ClassDeclaration: true, MethodDefinition: true, FunctionDeclaration: true },
                    contexts: ['TSInterfaceDeclaration', 'TSMethodSignature'],
                },
            ],
        },
    },
    {
        // test helpers and fixtures
        files: ['test/**/*.ts', 'src/**/*.test.ts'],
        rules: {
            'jsdoc/require-jsdoc': 'off',
        },
    },
];
