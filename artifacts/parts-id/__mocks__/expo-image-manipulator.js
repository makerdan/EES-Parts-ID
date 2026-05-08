const SaveFormat = { JPEG: 'jpeg', PNG: 'png' };

const manipulateAsync = jest.fn(async (uri, _actions, _options) => ({
  uri: `resized://${uri}`,
  base64: 'RESIZED_BASE64',
}));

module.exports = { manipulateAsync, SaveFormat };
