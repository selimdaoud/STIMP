import globals from 'globals';

export default [
    {
        files: ['js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
            },
        },
        rules: {
            // Les deux règles qui auraient évité les bugs de ce soir
            'no-shadow': 'error',
            'no-use-before-define': ['error', { functions: false, classes: false, variables: true }],

            // Qualité générale
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-undef': 'error',
        },
    },
];
