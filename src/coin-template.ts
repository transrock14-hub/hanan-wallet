/** Shown in the app. The three header lines are the name, symbol, and supply used at deploy time. */
export const defaultCoinTemplate = () => `// Name: Hanan Coin
// Symbol: HAN
// Supply: 1000000

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract StudyCoin {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(string memory coinName, string memory coinSymbol, uint256 wholeSupply) {
        require(bytes(coinName).length > 0 && bytes(coinName).length <= 32, "name");
        require(bytes(coinSymbol).length > 0 && bytes(coinSymbol).length <= 8, "symbol");
        require(wholeSupply > 0, "supply");
        name = coinName;
        symbol = coinSymbol;
        uint256 amount = wholeSupply * (10 ** uint256(decimals));
        totalSupply = amount;
        balanceOf[msg.sender] = amount;
        emit Transfer(address(0), msg.sender, amount);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(to != address(0), "recipient");
        uint256 bal = balanceOf[msg.sender];
        require(bal >= value, "balance");
        unchecked {
            balanceOf[msg.sender] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
`;

export function parseCoinTemplate(src: string) {
  return {
    name: src.match(/^\/\/ Name:\s*(.*)$/m)?.[1]?.trim() ?? '',
    symbol: src.match(/^\/\/ Symbol:\s*(.*)$/m)?.[1]?.trim() ?? '',
    supply: src.match(/^\/\/ Supply:\s*(.*)$/m)?.[1]?.trim() ?? '',
  };
}

export function setCoinHeader(src: string, field: 'Name' | 'Symbol' | 'Supply', value: string) {
  const line = `// ${field}: ${value}`;
  const re = new RegExp(`^\\/\\/ ${field}:.*$`, 'm');
  return re.test(src) ? src.replace(re, line) : `${line}\n${src}`;
}
