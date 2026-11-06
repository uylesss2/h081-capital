// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.20;

contract SpendVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 6954424815294991816178796412270364743662447319650191411534086472468832717882;
    uint256 constant deltax2 = 12018105325957052718464886487871152425289263121779407214258278045949671494913;
    uint256 constant deltay1 = 4498224188212204652507915059294342747823630062172765590690240807553136530806;
    uint256 constant deltay2 = 14102118858497104048762440013217703394603437118691059240234297040132238064056;

    
    uint256 constant IC0x = 1163188403844458196918525309646027450950902617977866151925697414452541960048;
    uint256 constant IC0y = 7445526411679378952750678174130854131598336961704084936266918329334964935842;
    
    uint256 constant IC1x = 2532242714632362566899837886716971508451404708320840285936946991092413514562;
    uint256 constant IC1y = 14572620272999338233761185292622650075915959417360765811132251007036214954942;
    
    uint256 constant IC2x = 17072884206058836498093018207279489681137879942550703111575798172407061781562;
    uint256 constant IC2y = 482630873365356880157926438093591066882203353710166127887166746698784216581;
    
    uint256 constant IC3x = 15168443433295662812074700648101389861322351678799331455636687036163612174621;
    uint256 constant IC3y = 3176423541444347530365876287763595952258896603175064471919738416748277006424;
    
    uint256 constant IC4x = 17616199001012813829949023784917551395900809802121425394861707587095953821769;
    uint256 constant IC4y = 6537639612841092157054451059824859188224565891686902637376065575370002255069;
    
    uint256 constant IC5x = 14454172552009685878926486355788208881621152012765016791550656991243208494411;
    uint256 constant IC5y = 17058277269295970665068306052887696721133296973371739687026063075623210534497;
    
    uint256 constant IC6x = 12403991419137532131094148376342632880067643863911955284809468656665318514930;
    uint256 constant IC6y = 7908099344835886158744310265727900593116948255012096974897564718409917860788;
    
    uint256 constant IC7x = 10982014160002146864491000754465776126568578466707995535316408121172076672404;
    uint256 constant IC7y = 3908352559698912514471623422311829877123184788456759888897933484165435833220;
    
    uint256 constant IC8x = 5673642571413882341319214878963120493419791846765815735418218669646279995875;
    uint256 constant IC8y = 12493869864000437842872736411962931371424394665416461104300729265017416461078;
    
    uint256 constant IC9x = 15487877995409836296050042306172971185144540452118914434073600763225770725815;
    uint256 constant IC9y = 5265828164159627473476522521056399336158254429455407035735796032742727241535;
    
    uint256 constant IC10x = 3665015871377045378010144694405906223877453482766866298326116044617810323665;
    uint256 constant IC10y = 14200065954158366251630321072969774685158687238320634226477841228245809212605;
    
    uint256 constant IC11x = 8212515790588822737162178408789660794698278038480011247521257455699082718631;
    uint256 constant IC11y = 8273342320156343313856737288098245600206623189471085103323194563399683187665;
    
    uint256 constant IC12x = 5228701766762603841655620002305363065645527578256317396030713648779215743803;
    uint256 constant IC12y = 6014841071707319696014275841744543651868249259353479995327785530801260504240;
    
    uint256 constant IC13x = 15602156096994768929889053187608594939806730849467775472416874566557498475463;
    uint256 constant IC13y = 13272093760804186360018315169971564136794163412453021539412464779126946780856;
    
    uint256 constant IC14x = 4196904065897711051410467465363156431382187048553254840910453435687492880358;
    uint256 constant IC14y = 19898131552459639629460771178709667368186529434057646009015361127905372303566;
    
    uint256 constant IC15x = 13847872702604648657068627917514079332001729794970438352839578472069608088579;
    uint256 constant IC15y = 18799019539582232674393373042929508587941141634399759511112835146993954294637;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[15] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
