const React = require('react');
function Icon(props) {
  return React.createElement('span', { 'data-icon': props.name, 'aria-hidden': 'true' });
}
module.exports = {
  Feather: Icon,
  Ionicons: Icon,
  MaterialIcons: Icon,
  MaterialCommunityIcons: Icon,
  AntDesign: Icon,
  FontAwesome: Icon,
  FontAwesome5: Icon,
  Entypo: Icon,
};
